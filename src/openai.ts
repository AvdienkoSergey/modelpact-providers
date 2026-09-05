/**
 * An OpenAI-compatible server, which is a dialect rather than a company.
 *
 * `https://api.openai.com/v1` is the default and one instance of it. The same
 * two endpoints answer on vLLM, llama.cpp, LM Studio, OpenRouter, Groq and
 * Ollama's own compatibility layer, so `baseUrl` is the whole difference
 * between them and `apiKey` is optional — a model on this machine wants no key,
 * and a type that demanded one would be describing a service instead of a
 * protocol.
 *
 * Two endpoints are the whole backend: `/models` says what is served,
 * `/chat/completions` generates. There is no third, because there is nothing to
 * download — the weights are the server's problem, which is why this is the one
 * backend here that never answers `needs-download`.
 *
 * Shapes were read off the wire, not off the docs: a stream is Server-Sent
 * Events whose last frame carries the counts, a tool call arrives in fragments
 * keyed by `index` with its arguments as a JSON string rather than an object,
 * and an error is an HTTP status with `{"error": {"message": "…"}}` — or with
 * `{"error": "…"}`, which is what several compatible servers send instead.
 */
import {
  AiError,
  contextUsage,
  createProvider,
  err,
  findTool,
  ndjsonLines,
  ok,
  runTool,
  tokens,
  type AiFailure,
  type AiMessage,
  type AiProvider,
  type Availability,
  type ConnectOptions,
  type ContextUsage,
  type GenerateRequest,
  type JsonSchema,
  type ModelBackend,
  type ModelConnection,
  type Result,
  type Tool,
} from "modelpact/backend";

export interface OpenAiConfig {
  /** The id as `/models` lists it, such as `gpt-4o-mini` or `qwen2.5-coder`. */
  readonly model: string;
  /**
   * Up to and including the version segment, because that is where servers
   * disagree: OpenAI serves `/v1`, LM Studio serves `/v1`, and a proxy can
   * serve neither. A trailing slash is trimmed rather than doubled into the
   * path.
   */
  readonly baseUrl?: string;
  /**
   * Absent, no `Authorization` header is sent at all — which is what a local
   * server wants, and what an unauthenticated one refuses. Note where this
   * ends up: a key in a browser bundle is a key handed to everyone who loads
   * the page. Point `baseUrl` at your own server there and keep the key on it.
   */
  readonly apiKey?: string;
  /**
   * The window to measure against. Optional and defaulted to nothing on
   * purpose: no OpenAI-compatible server reports the window it loaded a model
   * with, so a number here is the caller's declaration and not a discovery.
   * Absent, `usage()` answers `unknown` rather than inventing a denominator.
   *
   * Declared, it is also a budget: a transcript past it is an overflow, told
   * by the counts rather than by the server. See `#hasSpentTheWindow`.
   */
  readonly contextWindow?: number;
  /** For a proxy, an extra header, or a test with no server behind it. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * How many times one turn may come back with tool calls before it is failed.
   * Per turn, not per session: a model that keeps asking spends the window on
   * its own questions and never answers.
   */
  readonly maxToolRounds?: number;
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  maxToolRounds: 8,
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  const isObject = typeof value === "object" && value !== null;
  return isObject && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * `baseUrl` without its trailing slashes, walked rather than matched.
 *
 * `/\/+$/` is a polynomial backtrack: on a long run of slashes the engine
 * retries the greedy `\/+` from every position in it before `$` can fail. That
 * is harmless on a URL somebody typed into a config and not harmless as a
 * published API, where a consumer is free to build this string from something a
 * user sent — which is what CodeQL means by uncontrolled, and it is right. An
 * index walk is linear and says plainly what it does.
 */
const withoutTrailingSlashes = (url: string): string => {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
};

interface Endpoint {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly call: typeof globalThis.fetch;
}

const toEndpoint = (config: OpenAiConfig): Endpoint => ({
  baseUrl: withoutTrailingSlashes(config.baseUrl ?? DEFAULTS.baseUrl),
  headers:
    config.apiKey === undefined
      ? {}
      : { authorization: `Bearer ${config.apiKey}` },
  // Bound, and not optional: in a browser `fetch` is a method of the window and
  // throws `TypeError: Illegal invocation` once it is held on its own. Node
  // does not care, so nothing but a page catches this.
  call: config.fetch ?? globalThis.fetch.bind(globalThis),
});

const postTo = (
  endpoint: Endpoint,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> =>
  endpoint.call(`${endpoint.baseUrl}${path}`, {
    method: "POST",
    headers: { ...endpoint.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

/** `{"error": {"message": "…"}}` is OpenAI's; `{"error": "…"}` is what several compatible servers send. */
const readErrorText = (body: unknown): string | null => {
  const errorValue = asRecord(body)?.error;
  return asString(errorValue) ?? asString(asRecord(errorValue)?.message);
};

const failureFromResponse = async (response: Response): Promise<AiFailure> => {
  const text = await response.text().catch(() => "");
  const detail =
    readErrorText(parseJson(text)) ?? `${response.status} from the server`;
  // Three moves, three kinds. 400 is this side building the request badly; 401
  // and 403 are the key, which no retry of the same request will fix; anything
  // else — a 404 on a wrong `baseUrl`, a 429, a 500 — is the server's own
  // trouble, and the detail is where it says which.
  if (response.status === 400) return { kind: "invalid-input", detail };
  if (response.status === 401 || response.status === 403)
    return { kind: "not-allowed" };
  return { kind: "failed", detail };
};

/**
 * What `/models` said, in the three shapes that matter.
 *
 * `unlisted` is the one that earns its place: the endpoint is optional in
 * practice — a proxy can withhold it, and a single-model server can answer an
 * empty list — and refusing on its absence would lock out servers that work.
 * The chat call is the only thing that can prove a model, so a listing that
 * does not answer is not evidence against one.
 */
type Listing =
  | { readonly kind: "listed"; readonly names: readonly string[] }
  | { readonly kind: "unlisted" }
  | { readonly kind: "refused" };

const listModels = async (endpoint: Endpoint): Promise<Listing> => {
  const response = await endpoint.call(`${endpoint.baseUrl}/models`, {
    headers: endpoint.headers,
  });
  if (response.status === 401 || response.status === 403)
    return { kind: "refused" };
  if (!response.ok) return { kind: "unlisted" };
  const listed = asArray(
    asRecord(await response.json().catch(() => null))?.data,
  );
  const names = listed
    .map((entry) => asString(asRecord(entry)?.id))
    .filter((name): name is string => name !== null);
  return names.length === 0 ? { kind: "unlisted" } : { kind: "listed", names };
};

const getAvailability = async (config: OpenAiConfig): Promise<Availability> => {
  const endpoint = toEndpoint(config);
  let listing: Listing;
  try {
    listing = await listModels(endpoint);
  } catch (cause) {
    // Nothing answering is not a failed request, it is no server here.
    return { kind: "unavailable", reason: { kind: "unsupported", cause } };
  }
  if (listing.kind === "refused")
    return { kind: "unavailable", reason: { kind: "not-allowed" } };
  // A listing that named models and did not name this one is the one case
  // where the absence is evidence.
  if (listing.kind === "listed" && !listing.names.includes(config.model))
    return {
      kind: "unavailable",
      reason: { kind: "unsupported-config", languages: [] },
    };
  return { kind: "ready" };
};

/** A call as the wire carries it: the arguments are a JSON string, not an object. */
interface WireToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface WireTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
}

/** What `/chat/completions` takes beyond the contract's two roles. */
type ChatMessage =
  | AiMessage
  | { readonly role: "system"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls: readonly WireToolCall[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_call_id: string;
    };

interface ChatBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly stream_options?: { readonly include_usage: true };
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: {
      readonly name: string;
      readonly schema: JsonSchema;
    };
  };
  readonly tools?: readonly WireTool[];
}

/** One call being assembled across frames; `index` is what ties the fragments together. */
interface DraftToolCall {
  id: string | null;
  name: string | null;
  readonly argumentParts: string[];
}

/**
 * One `/chat/completions` answer being read. The deltas go out as they arrive;
 * what stays behind is the text and the calls, which the next round is built
 * from.
 */
interface OpenRound {
  readonly reader: ReadableStreamDefaultReader<string>;
  readonly contentParts: string[];
  readonly drafts: Map<number, DraftToolCall>;
}

const toWireTools = (tools: readonly Tool[]): WireTool[] =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

/**
 * Server-Sent Events, as much of the protocol as a chat completion uses:
 * frames separated by a blank line, one `data:` field each, and a last frame
 * of `[DONE]`.
 *
 * `ndjsonLines` upstream does the cutting and drops the blank separators, so
 * what arrives here is one field per call. Anything that is not `data:` is a
 * field this protocol does not send — a `:` keep-alive comment from a proxy is
 * the one seen in practice, and dropping it is the whole handling it needs.
 */
const serverSentData = (): TransformStream<string, string> =>
  new TransformStream({
    transform: (line, controller) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice("data:".length).trim();
      if (data === "" || data === "[DONE]") return;
      controller.enqueue(data);
    },
  });

/**
 * A call arrives in pieces: the id and the name once, the arguments as
 * fragments of one JSON string, every piece carrying the `index` it belongs to.
 * Concatenating in arrival order without that key would interleave two calls
 * made in the same turn into one unparseable string.
 */
const readToolCallDeltas = (
  delta: Record<string, unknown> | null,
  drafts: Map<number, DraftToolCall>,
): void => {
  for (const listed of asArray(delta?.tool_calls)) {
    const listedCall = asRecord(listed);
    // A server that omits `index` is sending one call at a time, so the count
    // so far is the key it would have used.
    const index = asNumber(listedCall?.index) ?? drafts.size;
    const draft = drafts.get(index) ?? {
      id: null,
      name: null,
      argumentParts: [],
    };
    drafts.set(index, draft);
    draft.id ??= asString(listedCall?.id);
    const calledFunction = asRecord(listedCall?.function);
    draft.name ??= asString(calledFunction?.name);
    const argumentPart = asString(calledFunction?.arguments);
    if (argumentPart !== null) draft.argumentParts.push(argumentPart);
  }
};

/** In `index` order, because that is the order the model made them in; one with no name never happened. */
const toToolCalls = (drafts: Map<number, DraftToolCall>): WireToolCall[] => {
  const indexes = [...drafts.keys()].sort((one, other) => one - other);
  const calls: WireToolCall[] = [];
  for (const index of indexes) {
    const draft = drafts.get(index);
    if (draft?.name == null) continue;
    calls.push({
      // Several compatible servers leave the id out. The next round needs one
      // to tie each answer to its call, so an index-shaped one stands in.
      id: draft.id ?? `call_${index}`,
      type: "function",
      function: { name: draft.name, arguments: draft.argumentParts.join("") },
    });
  }
  return calls;
};

/** Whatever the model sent, read as an object; a fragmented string that never closed is no arguments at all. */
const toToolInput = (call: WireToolCall): Record<string, unknown> =>
  asRecord(parseJson(call.function.arguments)) ?? {};

const readWhole = async (
  stream: ReadableStream<string>,
): Promise<Result<string, AiFailure>> => {
  const reader = stream.getReader();
  const parts: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return ok(parts.join(""));
      parts.push(chunk.value);
    }
  } catch (error) {
    return err(
      error instanceof AiError
        ? error.failure
        : { kind: "failed", detail: "the chat stream broke", cause: error },
    );
  }
};

class OpenAiModel implements ModelConnection {
  readonly #endpoint: Endpoint;
  readonly #model: string;
  readonly #contextWindow: number | undefined;
  readonly #system: string | undefined;
  readonly #tools: readonly Tool[];
  readonly #maxToolRounds: number;
  readonly #reportOverflow: () => void;
  /** The last turn's counts, which is what the context holds now rather than a running sum. */
  #usedTokens = 0;

  constructor(config: OpenAiConfig, options: ConnectOptions) {
    this.#endpoint = toEndpoint(config);
    this.#model = config.model;
    this.#contextWindow = config.contextWindow;
    this.#system = options.session.system;
    this.#tools = options.request.tools ?? [];
    this.#maxToolRounds = config.maxToolRounds ?? DEFAULTS.maxToolRounds;
    this.#reportOverflow = options.reportOverflow;
  }

  readonly generateStream = async (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<ReadableStream<string>, AiFailure>> => {
    const conversation = this.#toConversation(input, request);
    const responseResult = await this.#chat(conversation, request, true);
    if (!responseResult.ok) return responseResult;
    const body = responseResult.value.body;
    if (body === null)
      return err({ kind: "failed", detail: "the chat sent no body" });
    return ok(this.#streamRounds(body, conversation, request));
  };

  readonly generateWhole = async (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<string, AiFailure>> => {
    // A turn with tools is rounds, and rounds are the streaming path read to
    // its end; only a plain turn has a whole-answer call worth a second shape.
    if (this.#tools.length > 0) {
      const streamResult = await this.generateStream(input, request);
      return streamResult.ok ? readWhole(streamResult.value) : streamResult;
    }
    const conversation = this.#toConversation(input, request);
    const responseResult = await this.#chat(conversation, request, false);
    if (!responseResult.ok) return responseResult;
    const parsedBody = asRecord(
      await responseResult.value.json().catch(() => null),
    );
    if (parsedBody === null)
      return err({ kind: "failed", detail: "the chat sent no JSON" });
    const choice = asRecord(asArray(parsedBody.choices)[0]);
    const answerText = asString(asRecord(choice?.message)?.content);
    if (answerText === null)
      return err({ kind: "failed", detail: "the chat sent no message" });
    this.#charge(asRecord(parsedBody.usage), asString(choice?.finish_reason));
    return ok(answerText);
  };

  readonly usage = (): ContextUsage => {
    if (this.#contextWindow === undefined) return { kind: "unknown" };
    const used = tokens(this.#usedTokens) ?? ZERO_TOKENS;
    return contextUsage(used, this.#contextWindow);
  };

  /**
   * Nothing to release. The connection is one `fetch` per turn and the server
   * keeps nothing between them, so there is no session on the other end to
   * close.
   */
  readonly dispose = (): void => undefined;

  #toConversation(input: string, request: GenerateRequest): ChatMessage[] {
    const askedMessage: AiMessage = { role: "user", content: input };
    const conversation: ChatMessage[] = [...request.history, askedMessage];
    // A real role here, unlike the daemon next door: this dialect has one, and
    // a server that prefers `developer` maps `system` onto it itself.
    return this.#system === undefined
      ? conversation
      : [{ role: "system", content: this.#system }, ...conversation];
  }

  async #chat(
    messages: readonly ChatMessage[],
    request: GenerateRequest,
    stream: boolean,
  ): Promise<Result<Response, AiFailure>> {
    const body: ChatBody = {
      model: this.#model,
      messages,
      stream,
      // Only with `stream`: sent alongside `stream: false` it is a 400.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.schema === undefined
        ? {}
        : {
            response_format: {
              type: "json_schema",
              json_schema: { name: "answer", schema: request.schema },
            },
          }),
      ...(this.#tools.length === 0 ? {} : { tools: toWireTools(this.#tools) }),
    };
    const response = await postTo(
      this.#endpoint,
      "/chat/completions",
      body,
      request.signal,
    );
    return response.ok
      ? ok(response)
      : err(await failureFromResponse(response));
  }

  /**
   * Rounds: an answer is read to its end, and where it ends in tool calls the
   * calls are answered and the conversation sent again. Only text reaches the
   * caller, so a turn that is all calls is silent until its last round.
   * Bounded, because a model that keeps calling would spend the window on it.
   */
  #streamRounds(
    firstBody: NonNullable<Response["body"]>,
    firstConversation: readonly ChatMessage[],
    request: GenerateRequest,
  ): ReadableStream<string> {
    let conversation = firstConversation;
    let currentRound = this.#openRound(firstBody);
    let roundsTaken = 0;

    const advance = async (
      controller: ReadableStreamDefaultController<string>,
    ): Promise<void> => {
      for (;;) {
        const chunk = await currentRound.reader.read();
        if (!chunk.done) {
          controller.enqueue(chunk.value);
          return;
        }
        const calls = toToolCalls(currentRound.drafts);
        if (calls.length === 0) {
          controller.close();
          return;
        }
        roundsTaken += 1;
        if (roundsTaken > this.#maxToolRounds) {
          throw new AiError({
            kind: "failed",
            detail: `the model called tools ${roundsTaken} times without answering`,
          });
        }
        conversation = await this.#answerToolCalls(
          conversation,
          currentRound.contentParts.join(""),
          calls,
          request.signal,
        );
        const nextResult = await this.#chat(conversation, request, true);
        if (!nextResult.ok) throw new AiError(nextResult.error);
        const nextBody = nextResult.value.body;
        if (nextBody === null)
          throw new AiError({
            kind: "failed",
            detail: "the chat sent no body",
          });
        currentRound = this.#openRound(nextBody);
      }
    };

    return new ReadableStream<string>({
      pull: (controller) => advance(controller),
      cancel: (reason) => currentRound.reader.cancel(reason),
    });
  }

  /**
   * Content out, calls and counts kept.
   *
   * `finish_reason` and the counts arrive in different frames — the reason on
   * the last frame that has a choice, the counts on one after it whose
   * `choices` is empty — so the reason is remembered and every frame from there
   * on charges. `reportOverflow` is idempotent, which is what makes charging
   * twice cost nothing; a server that ignored `stream_options` and sent no
   * counts at all still reaches the `length` half of the check.
   */
  #openRound(body: NonNullable<Response["body"]>): OpenRound {
    const contentParts: string[] = [];
    const drafts = new Map<number, DraftToolCall>();
    let finishReason: string | null = null;
    const readFrames = new TransformStream<string, string>({
      transform: (data, controller) => {
        const frame = asRecord(parseJson(data));
        if (frame === null) return;
        const errorText = readErrorText(frame);
        if (errorText !== null)
          throw new AiError({ kind: "failed", detail: errorText });

        const choice = asRecord(asArray(frame.choices)[0]);
        finishReason = asString(choice?.finish_reason) ?? finishReason;
        const usage = asRecord(frame.usage);
        if (usage !== null || finishReason !== null)
          this.#charge(usage, finishReason);

        const delta = asRecord(choice?.delta);
        readToolCallDeltas(delta, drafts);
        const text = asString(delta?.content) ?? "";
        if (text === "") return;
        contentParts.push(text);
        controller.enqueue(text);
      },
    });
    const deltas = body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(ndjsonLines())
      .pipeThrough(serverSentData())
      .pipeThrough(readFrames);
    return { reader: deltas.getReader(), contentParts, drafts };
  }

  /**
   * The model's call goes back as its own turn, then each answer under the
   * `tool` role tied to it by `tool_call_id` — the dialect matches answers to
   * calls by id, not by name, so two calls to the same tool in one turn stay
   * apart. A name the model made up is answered rather than failing the turn:
   * the model can pick again, where a failed turn could not. A tool that throws
   * cannot be answered for, and ends the turn.
   */
  async #answerToolCalls(
    conversation: readonly ChatMessage[],
    saidText: string,
    calls: readonly WireToolCall[],
    signal: AbortSignal,
  ): Promise<ChatMessage[]> {
    const answered: ChatMessage[] = [
      ...conversation,
      { role: "assistant", content: saidText, tool_calls: calls },
    ];
    for (const call of calls) {
      const name = call.function.name;
      const tool = findTool(this.#tools, name);
      if (tool === undefined) {
        answered.push({
          role: "tool",
          content: `there is no tool called "${name}"`,
          tool_call_id: call.id,
        });
        continue;
      }
      const toolResult = await runTool(tool, toToolInput(call), signal);
      if (!toolResult.ok) throw new AiError(toolResult.error);
      answered.push({
        role: "tool",
        content: toolResult.value,
        tool_call_id: call.id,
      });
    }
    return answered;
  }

  /**
   * `prompt_tokens` is the whole prompt, history included, so the two counts
   * together are what the window holds after this turn. Summing across turns
   * would count the history once per turn. `total_tokens` is preferred where
   * the server sends it, because a server that bills for reasoning tokens puts
   * them there and in neither of the other two.
   */
  #charge(
    usage: Record<string, unknown> | null,
    finishReason: string | null,
  ): void {
    if (usage !== null) {
      const promptTokens = asNumber(usage.prompt_tokens) ?? 0;
      const answerTokens = asNumber(usage.completion_tokens) ?? 0;
      this.#usedTokens =
        asNumber(usage.total_tokens) ?? promptTokens + answerTokens;
    }
    if (this.#hasSpentTheWindow(finishReason)) this.#reportOverflow();
  }

  /**
   * Two ways to learn it, and they are independent.
   *
   * The server can say so: `max_tokens` is deliberately never sent, so
   * `finish_reason: "length"` can only mean the model ran out of context. And
   * the counts can say so against a `contextWindow` the caller declared, which
   * is the only reading available for a server that stopped without saying why
   * — and the only one at all for the many that never report a window.
   */
  #hasSpentTheWindow(finishReason: string | null): boolean {
    if (finishReason === "length") return true;
    return (
      this.#contextWindow !== undefined &&
      this.#usedTokens >= this.#contextWindow
    );
  }
}

const ZERO_TOKENS = tokens(0) as NonNullable<ReturnType<typeof tokens>>;

/**
 * Nothing to do but hand back a connection. There are no weights to fetch and
 * no session to open on the far side — `availability` already asked the only
 * question there was, and every turn is a request of its own.
 */
const connectOpenAi = (
  config: OpenAiConfig,
  options: ConnectOptions,
): Promise<Result<ModelConnection, AiFailure>> =>
  Promise.resolve(ok(new OpenAiModel(config, options)));

export function makeOpenAiProvider(config: OpenAiConfig): AiProvider {
  const backend: ModelBackend = {
    name: "openai",
    modalities: ["text"],
    tools: true,
    availability: () => getAvailability(config),
    connect: (options) => connectOpenAi(config, options),
  };
  return createProvider(backend);
}
