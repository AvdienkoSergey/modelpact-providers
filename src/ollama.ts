/**
 * Ollama on a machine you can reach over HTTP.
 *
 * The daemon keeps nothing between requests: `/api/chat` is handed the whole
 * conversation every time, which is what `request.history` is for. Three
 * endpoints are the whole backend — `/api/tags` says what is downloaded,
 * `/api/pull` downloads, `/api/chat` generates — and everything else the
 * contract promises is the lifecycle's, back in `modelpact`.
 *
 * Shapes here were read off a running daemon, not off the docs: a chat stream
 * is NDJSON whose last line carries the counts, a pull line carries `completed`
 * and `total` per layer, and an error is an HTTP status with `{"error": "…"}`.
 */
import {
  AiError,
  contextUsage,
  createProvider,
  err,
  findTool,
  fraction,
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
  type Fraction,
  type GenerateRequest,
  type ModelBackend,
  type ModelConnection,
  type Result,
  type Tool,
} from "modelpact/backend";

export interface OllamaConfig {
  /** The tag as `/api/tags` lists it, such as `granite4:350m`. */
  readonly model: string;
  /**
   * `127.0.0.1` and not `localhost`: the daemon binds the one, and the name
   * can resolve to the other family first and refuse the connection.
   */
  readonly host?: string;
  /**
   * Sent as `num_ctx`, and therefore the window in force rather than a guess
   * at one. The default matches the daemon's own; a model that can take more
   * will, at the price of the memory the cache for it costs.
   */
  readonly contextWindow?: number;
  /** For a proxy, an auth header, or a test with no daemon behind it. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * How many times one turn may come back with tool calls before it is failed.
   * Per turn, not per session: a model that keeps asking spends the window on
   * its own questions and never answers.
   */
  readonly maxToolRounds?: number;
}

const DEFAULTS = {
  host: "http://127.0.0.1:11434",
  contextWindow: 4096,
  maxToolRounds: 8,
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  const isObject = typeof value === "object" && value !== null;
  return isObject && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

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

interface Endpoint {
  readonly host: string;
  readonly call: typeof globalThis.fetch;
}

const toEndpoint = (config: OllamaConfig): Endpoint => ({
  host: config.host ?? DEFAULTS.host,
  // Bound, and not optional: in a browser `fetch` is a method of the window and
  // throws `TypeError: Illegal invocation` once it is held on its own. Node
  // does not care, so nothing but a page catches this (measured).
  call: config.fetch ?? globalThis.fetch.bind(globalThis),
});

const postTo = (
  endpoint: Endpoint,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> =>
  endpoint.call(`${endpoint.host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

/** The daemon says what went wrong in the body; a status alone would lose it. */
const failureFromResponse = async (response: Response): Promise<AiFailure> => {
  const text = await response.text().catch(() => "");
  const errorText = asString(asRecord(parseJson(text))?.error);
  const detail = errorText ?? `${response.status} from the daemon`;
  // 400 is the daemon reading the request and refusing it, which is a bug on
  // this side. Everything else is the daemon's own trouble.
  return response.status === 400
    ? { kind: "invalid-input", detail }
    : { kind: "failed", detail };
};

const listModels = async (endpoint: Endpoint): Promise<readonly string[]> => {
  const response = await endpoint.call(`${endpoint.host}/api/tags`);
  if (!response.ok) return [];
  const listedModels = asRecord(
    await response.json().catch(() => null),
  )?.models;
  if (!Array.isArray(listedModels)) return [];
  const names = listedModels.map((entry) => asString(asRecord(entry)?.model));
  return names.filter((name): name is string => name !== null);
};

const getAvailability = async (config: OllamaConfig): Promise<Availability> => {
  const endpoint = toEndpoint(config);
  let downloadedModels: readonly string[];
  try {
    downloadedModels = await listModels(endpoint);
  } catch (cause) {
    // Nothing answering is not a failed request, it is no Ollama here.
    return { kind: "unavailable", reason: { kind: "unsupported", cause } };
  }
  const isDownloaded = downloadedModels.includes(config.model);
  return isDownloaded
    ? { kind: "ready" }
    : { kind: "needs-download", started: false };
};

/**
 * Pull progress is per layer, and layers are announced as the pull reaches
 * them, so the denominator grows while it runs. The share can therefore stall,
 * and `ProgressMonitor` drops it if it would step back. `success` is what
 * makes the last report a 1, since that line carries no numbers.
 */
const readPullProgress = (
  reportProgress: (progress: Fraction) => void,
): TransformStream<string, string> => {
  const layers = new Map<string, { total: number; completed: number }>();
  return new TransformStream({
    transform: (line, controller) => {
      const parsedLine = asRecord(parseJson(line));
      if (parsedLine === null) return;
      const errorText = asString(parsedLine.error);
      if (errorText !== null)
        throw new AiError({ kind: "failed", detail: errorText });

      const digest = asString(parsedLine.digest);
      const total = asNumber(parsedLine.total);
      const completed = asNumber(parsedLine.completed) ?? 0;
      if (digest !== null && total !== null && total > 0) {
        layers.set(digest, { total, completed });
      }

      const isDone = asString(parsedLine.status) === "success";
      const pulledShare = isDone ? 1 : getPulledShare(layers);
      const progress = fraction(pulledShare);
      if (progress !== null) reportProgress(progress);
      controller.enqueue(line);
    },
  });
};

const getPulledShare = (
  layers: Map<string, { total: number; completed: number }>,
): number => {
  let total = 0;
  let completed = 0;
  for (const layer of layers.values()) {
    total += layer.total;
    completed += layer.completed;
  }
  return total === 0 ? 0 : completed / total;
};

const pullModel = async (
  endpoint: Endpoint,
  model: string,
  reportProgress: (progress: Fraction) => void,
): Promise<Result<null, AiFailure>> => {
  const response = await postTo(endpoint, "/api/pull", { model, stream: true });
  if (!response.ok) return err(await failureFromResponse(response));
  if (response.body === null)
    return err({ kind: "failed", detail: "the pull sent no body" });

  const lines = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(ndjsonLines())
    .pipeThrough(readPullProgress(reportProgress));
  const reader = lines.getReader();
  try {
    // Read to the end: the transform above is where the reporting happens, and
    // the body is not finished until it stops yielding.
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return ok(null);
    }
  } catch (error) {
    return err(
      error instanceof AiError
        ? error.failure
        : { kind: "failed", detail: "the pull was interrupted", cause: error },
    );
  }
};

interface OllamaToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

/** What `/api/chat` takes beyond the contract's two roles: a call the model made, and the answer to it. */
type ChatMessage =
  | AiMessage
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls: readonly OllamaToolCall[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_name: string;
    };

interface OllamaTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface ChatBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly options: { readonly num_ctx: number };
  readonly format?: Record<string, unknown>;
  readonly tools?: readonly OllamaTool[];
}

/**
 * One `/api/chat` answer being read. The deltas go out as they arrive; what
 * stays behind is the text and the calls, which the next round is built from.
 */
interface OpenRound {
  readonly reader: ReadableStreamDefaultReader<string>;
  readonly contentParts: string[];
  readonly toolCalls: OllamaToolCall[];
}

const toOllamaTools = (tools: readonly Tool[]): OllamaTool[] =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

/** A call carries `function.name` and `function.arguments`, an object; one without a name is skipped. */
const readToolCalls = (
  message: Record<string, unknown> | null,
): OllamaToolCall[] => {
  const listedCalls = message?.tool_calls;
  if (!Array.isArray(listedCalls)) return [];
  const readCalls: OllamaToolCall[] = [];
  for (const listedCall of listedCalls) {
    const calledFunction = asRecord(asRecord(listedCall)?.function);
    const name = asString(calledFunction?.name);
    if (name === null) continue;
    const callArguments = asRecord(calledFunction?.arguments) ?? {};
    readCalls.push({ function: { name, arguments: callArguments } });
  }
  return readCalls;
};

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

class OllamaModel implements ModelConnection {
  readonly #endpoint: Endpoint;
  readonly #model: string;
  readonly #contextWindow: number;
  readonly #system: string | undefined;
  readonly #tools: readonly Tool[];
  readonly #maxToolRounds: number;
  readonly #reportOverflow: () => void;
  /** The last turn's counts, which is what the context holds now rather than a running sum. */
  #usedTokens = 0;

  constructor(config: OllamaConfig, options: ConnectOptions) {
    this.#endpoint = toEndpoint(config);
    this.#model = config.model;
    this.#contextWindow = config.contextWindow ?? DEFAULTS.contextWindow;
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
    const answerText = asString(asRecord(parsedBody.message)?.content);
    if (answerText === null)
      return err({ kind: "failed", detail: "the chat sent no message" });
    this.#charge(parsedBody);
    return ok(answerText);
  };

  readonly usage = (): ContextUsage => {
    const used = tokens(this.#usedTokens) ?? ZERO_TOKENS;
    return contextUsage(used, this.#contextWindow);
  };

  /**
   * Nothing to release. The daemon unloads on its own timer, and telling it to
   * unload here would take the model out from under whoever else is on it.
   */
  readonly dispose = (): void => undefined;

  #toConversation(input: string, request: GenerateRequest): ChatMessage[] {
    const askedMessage: AiMessage = { role: "user", content: input };
    const conversation: ChatMessage[] = [...request.history, askedMessage];
    return this.#system === undefined
      ? conversation
      : [{ role: "user", content: this.#system }, ...conversation];
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
      options: { num_ctx: this.#contextWindow },
      ...(request.schema === undefined ? {} : { format: request.schema }),
      ...(this.#tools.length === 0
        ? {}
        : { tools: toOllamaTools(this.#tools) }),
    };
    const response = await postTo(
      this.#endpoint,
      "/api/chat",
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
   * Bounded, because a model that keeps calling would spend the window on it:
   * `granite4:350m` asks for the same listing until something stops it.
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
        if (currentRound.toolCalls.length === 0) {
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
          currentRound,
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

  /** Content out, calls and counts kept: the last line carries both `done` and the totals. */
  #openRound(body: NonNullable<Response["body"]>): OpenRound {
    const contentParts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    const readLines = new TransformStream<string, string>({
      transform: (line, controller) => {
        const parsedLine = asRecord(parseJson(line));
        if (parsedLine === null) return;
        const errorText = asString(parsedLine.error);
        if (errorText !== null)
          throw new AiError({ kind: "failed", detail: errorText });
        if (parsedLine.done === true) this.#charge(parsedLine);
        const message = asRecord(parsedLine.message);
        toolCalls.push(...readToolCalls(message));
        const delta = asString(message?.content) ?? "";
        if (delta === "") return;
        contentParts.push(delta);
        controller.enqueue(delta);
      },
    });
    const deltas = body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(ndjsonLines())
      .pipeThrough(readLines);
    return { reader: deltas.getReader(), contentParts, toolCalls };
  }

  /**
   * The model's call goes back as its own turn, then each answer with the
   * `tool` role, which is what the daemon's template expects. A name the model
   * made up is answered by name rather than failing the turn: the model can
   * pick again, where a failed turn could not. A tool that throws cannot be
   * answered for, and ends the turn.
   */
  async #answerToolCalls(
    conversation: readonly ChatMessage[],
    round: OpenRound,
    signal: AbortSignal,
  ): Promise<ChatMessage[]> {
    const answered: ChatMessage[] = [
      ...conversation,
      {
        role: "assistant",
        content: round.contentParts.join(""),
        tool_calls: round.toolCalls,
      },
    ];
    for (const call of round.toolCalls) {
      const name = call.function.name;
      const tool = findTool(this.#tools, name);
      if (tool === undefined) {
        answered.push({
          role: "tool",
          content: `there is no tool called "${name}"`,
          tool_name: name,
        });
        continue;
      }
      const toolResult = await runTool(tool, call.function.arguments, signal);
      if (!toolResult.ok) throw new AiError(toolResult.error);
      answered.push({
        role: "tool",
        content: toolResult.value,
        tool_name: name,
      });
    }
    return answered;
  }

  /**
   * `prompt_eval_count` is the whole prompt, history included, so the two
   * counts together are what the window holds after this turn. Summing across
   * turns would count the history once per turn.
   */
  #charge(finishedLine: Record<string, unknown>): void {
    const promptTokens = asNumber(finishedLine.prompt_eval_count) ?? 0;
    const answerTokens = asNumber(finishedLine.eval_count) ?? 0;
    this.#usedTokens = promptTokens + answerTokens;
    if (this.#hasSpentTheWindow(finishedLine)) this.#reportOverflow();
  }

  /**
   * A daemon that shifts context answers past `num_ctx` and the counts say so
   * on their own. One that stops instead ends the turn with `done_reason:
   * "length"` on counts that reach the window and go no further — the same
   * overflow, told rather than counted. Both are read here because which one
   * the daemon does is its build's to decide, not the caller's.
   *
   * `num_predict` is left unset, so `length` can only be the window; the count
   * is checked anyway, in case a model file sets one.
   */
  #hasSpentTheWindow(finishedLine: Record<string, unknown>): boolean {
    if (this.#usedTokens < this.#contextWindow) return false;
    return asString(finishedLine.done_reason) === "length";
  }
}

const ZERO_TOKENS = tokens(0) as NonNullable<ReturnType<typeof tokens>>;

const connectOllama = async (
  config: OllamaConfig,
  options: ConnectOptions,
): Promise<Result<ModelConnection, AiFailure>> => {
  const endpoint = toEndpoint(config);
  let downloadedModels: readonly string[];
  try {
    downloadedModels = await listModels(endpoint);
  } catch (cause) {
    return err({ kind: "unsupported", cause });
  }
  if (!downloadedModels.includes(config.model)) {
    const pullResult = await pullModel(
      endpoint,
      config.model,
      options.reportProgress,
    );
    if (!pullResult.ok) return pullResult;
  }
  return ok(new OllamaModel(config, options));
};

export function makeOllamaProvider(config: OllamaConfig): AiProvider {
  const backend: ModelBackend = {
    name: "ollama",
    modalities: ["text"],
    tools: true,
    availability: () => getAvailability(config),
    connect: (options) => connectOllama(config, options),
  };
  return createProvider(backend);
}
