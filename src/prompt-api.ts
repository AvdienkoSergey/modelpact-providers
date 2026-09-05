/**
 * Chrome's built-in model, through the Prompt API.
 *
 * The one backend that keeps the conversation itself: `LanguageModel` is a
 * session object, `prompt()` appends to it, and `request.history` is therefore
 * read by nobody here. Two more things it owns that the others do not — it
 * fires its own `contextoverflow`, which is forwarded rather than re-derived,
 * and it reports usage against a window it decides.
 *
 * It lives in a page and nowhere else. In node the global is missing, and
 * `access` answers `unavailable` with `unsupported` rather than throwing.
 *
 * The declarations are `@types/dom-chromium-ai`, patched under `patches/` to
 * close the gap between the IDL and the spec: several states the algorithm
 * rejects at runtime are writable in the IDL, and a TS error at the keyboard
 * beats a `TypeError` in the browser. They are named in function bodies and
 * nowhere in a signature that leaves this file: an exported type naming
 * `LanguageModel` puts the same name in the emitted `.d.ts`, and a consumer
 * who has not installed those declarations, or who lists `types` explicitly,
 * then cannot compile this package at all. `src/surface.ts` is the guard that
 * keeps it that way, and the WebGPU backend next door is where the lesson
 * was learned.
 */
import {
  AiError,
  contextUsage,
  createProvider,
  err,
  failureFromError,
  fraction,
  ok,
  runTool,
  tokens,
  type AiFailure,
  type AiProvider,
  type Availability,
  type ConnectOptions,
  type ContextUsage,
  type GenerateRequest,
  type ModelBackend,
  type ModelConnection,
  type ModelRequest,
  type Result,
  type SessionOptions,
  type Tool,
} from "modelpact/backend";

/**
 * The page's own class, or nothing.
 *
 * There is no way to hand one in. A polyfill is already this — it defines the
 * global — and a test sets the global too, which is the same path the browser
 * takes rather than one beside it.
 *
 * `typeof` and not a bare read: outside a page the name is not declared, and
 * naming it there throws rather than answering undefined.
 */
const getPlatformApi = (): typeof LanguageModel | null =>
  typeof LanguageModel === "undefined" ? null : LanguageModel;

const toExpectations = (
  askedExpectations: ModelRequest["inputs"],
): LanguageModelExpected[] | undefined => {
  if (askedExpectations === undefined || askedExpectations.length === 0)
    return undefined;
  return askedExpectations.map((expectation) => ({
    type: expectation.type,
    ...(expectation.languages === undefined
      ? {}
      : { languages: [...expectation.languages] }),
  }));
};

/**
 * What a tool needs from the turn it runs in. Tools are bound at `create`,
 * before any turn exists, so each turn puts its signal in here and takes out
 * the failure a tool left behind.
 */
interface ToolTurn {
  signal: AbortSignal;
  failure: AiFailure | null;
}

const NEVER_ABORTED = new AbortController().signal;

const makeToolTurn = (): ToolTurn => ({ signal: NEVER_ABORTED, failure: null });

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The browser hands `execute` the model's arguments and nothing else. One
 * plain object, which is what Chrome's examples pass, goes through as the
 * input; anything else is kept whole under `arguments`. Unverified against a
 * running call: no Chrome to date has created a session with tools here —
 * 152 refuses at `create`, measured.
 */
const toToolInput = (args: readonly unknown[]): Record<string, unknown> =>
  asRecord(args[0]) ?? { arguments: [...args] };

const toPlatformTools = (
  tools: readonly Tool[],
  turn: ToolTurn,
): LanguageModelTool[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (...args: unknown[]) => {
      const toolResult = await runTool(tool, toToolInput(args), turn.signal);
      if (toolResult.ok) return toolResult.value;
      // Remembered as well as thrown: whatever the browser does with a
      // rejected execute, the turn ends with this failure.
      turn.failure = toolResult.error;
      throw new AiError(toolResult.error);
    },
  }));

/** Chrome 152 refuses tools unless a tool-call output is expected; the spec text does not say so (measured). */
const withToolCallOutput = (
  outputs: LanguageModelExpected[] | undefined,
  hasTools: boolean,
): LanguageModelExpected[] | undefined =>
  hasTools ? [...(outputs ?? []), { type: "tool-call" }] : outputs;

const toCoreOptions = (
  request: ModelRequest,
  turn: ToolTurn,
): LanguageModelCreateCoreOptions => {
  const tools = request.tools ?? [];
  const inputs = toExpectations(request.inputs);
  const outputs = withToolCallOutput(
    toExpectations(request.outputs),
    tools.length > 0,
  );
  return {
    ...(inputs === undefined ? {} : { expectedInputs: inputs }),
    ...(outputs === undefined ? {} : { expectedOutputs: outputs }),
    ...(tools.length === 0 ? {} : { tools: toPlatformTools(tools, turn) }),
  };
};

/** The spec's four strings, read off the declaration so a fifth cannot be missed. */
type SpecAvailability = Awaited<ReturnType<typeof LanguageModel.availability>>;

/**
 * The four the spec has, against the three the contract has. `downloading` and
 * `downloadable` are one branch here and differ only in `started`, which is the
 * question a caller actually has: is someone already fetching this.
 */
const toAvailability = (specAvailability: SpecAvailability): Availability => {
  switch (specAvailability) {
    case "available":
      return { kind: "ready" };
    case "downloadable":
      return { kind: "needs-download", started: false };
    case "downloading":
      return { kind: "needs-download", started: true };
    case "unavailable":
      // Empty lists: the spec says no for the whole request without naming a
      // part, and inventing one would be worse than saying nothing.
      return {
        kind: "unavailable",
        reason: { kind: "unsupported-config", languages: [] },
      };
  }
};

const getAvailability = async (
  request: ModelRequest,
): Promise<Availability> => {
  const api = getPlatformApi();
  if (api === null)
    return { kind: "unavailable", reason: { kind: "unsupported" } };
  try {
    const specAvailability = await api.availability(
      toCoreOptions(request, makeToolTurn()),
    );
    return toAvailability(specAvailability);
  } catch (error) {
    // `NotAllowedError` for the permissions policy, `InvalidStateError` for a
    // document that is not fully active: both are refusals, not crashes.
    return { kind: "unavailable", reason: failureFromError(error) };
  }
};

/** System first or not at all, which is what the patched tuple type says too. */
const toInitialPrompts = (
  session: SessionOptions,
): LanguageModelCreateOptions["initialPrompts"] => {
  const historyPrompts: LanguageModelMessage[] = (session.history ?? []).map(
    (message) => ({ role: message.role, content: message.content }),
  );
  if (session.system === undefined)
    return historyPrompts.length === 0 ? undefined : historyPrompts;
  return [{ role: "system", content: session.system }, ...historyPrompts];
};

const toPromptOptions = (
  request: GenerateRequest,
): LanguageModelPromptOptions =>
  request.schema === undefined
    ? { signal: request.signal }
    : { signal: request.signal, responseConstraint: request.schema };

/**
 * `contextUsage` and `contextWindow` replaced `inputUsage` and `inputQuota`,
 * and a browser in the field may have either pair. Read as unknown because the
 * declarations promise the new names on a version that has only the old.
 */
const readUsage = (session: LanguageModel): ContextUsage => {
  const sessionFields = session as unknown as Record<string, unknown>;
  const used = readNumber(sessionFields, "contextUsage", "inputUsage");
  const windowTokens = readNumber(sessionFields, "contextWindow", "inputQuota");
  if (used === null || windowTokens === null) return { kind: "unknown" };
  const usedTokens = tokens(used);
  return usedTokens === null
    ? { kind: "unknown" }
    : contextUsage(usedTokens, windowTokens);
};

const readNumber = (
  sessionFields: Record<string, unknown>,
  currentName: string,
  olderName: string,
): number | null => {
  const value = sessionFields[currentName] ?? sessionFields[olderName];
  return typeof value === "number" ? value : null;
};

class PromptApiModel implements ModelConnection {
  readonly #session: LanguageModel;
  readonly #turn: ToolTurn;

  constructor(session: LanguageModel, turn: ToolTurn) {
    this.#session = session;
    this.#turn = turn;
  }

  readonly generateStream = (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<ReadableStream<string>, AiFailure>> => {
    try {
      this.#beginTurn(request);
      const deltas = this.#session.promptStreaming(
        input,
        toPromptOptions(request),
      );
      return Promise.resolve(ok(deltas.pipeThrough(this.#failIfToolFailed())));
    } catch (error) {
      return Promise.resolve(err(this.#refineFailure(error)));
    }
  };

  readonly generateWhole = async (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<string, AiFailure>> => {
    try {
      this.#beginTurn(request);
      const answerText = await this.#session.prompt(
        input,
        toPromptOptions(request),
      );
      const toolFailure = this.#turn.failure;
      return toolFailure === null ? ok(answerText) : err(toolFailure);
    } catch (error) {
      return err(this.#refineFailure(error));
    }
  };

  readonly usage = (): ContextUsage => readUsage(this.#session);

  readonly dispose = (): void => {
    this.#session.destroy();
  };

  #beginTurn(request: GenerateRequest): void {
    this.#turn.signal = request.signal;
    this.#turn.failure = null;
  }

  /** A stream that ended is not an answer if a tool failed on the way: the end is where that is checked. */
  #failIfToolFailed(): TransformStream<string, string> {
    return new TransformStream({
      flush: () => {
        const toolFailure = this.#turn.failure;
        if (toolFailure !== null) throw new AiError(toolFailure);
      },
    });
  }

  /**
   * `QuotaExceededError` carries no measurement, and the generic mapping says
   * so; holding the session is what lets this one attach the reading. A tool
   * failure outranks whatever the browser threw about it.
   */
  #refineFailure(error: unknown): AiFailure {
    const toolFailure = this.#turn.failure;
    if (toolFailure !== null) return toolFailure;
    const failure = failureFromError(error);
    return failure.kind === "context-overflow"
      ? { ...failure, usage: this.usage() }
      : failure;
  }
}

const connectPromptApi = async (
  options: ConnectOptions,
): Promise<Result<ModelConnection, AiFailure>> => {
  const api = getPlatformApi();
  if (api === null) return err({ kind: "unsupported" });

  const initialPrompts = toInitialPrompts(options.session);
  const turn = makeToolTurn();
  try {
    const session = await api.create({
      ...toCoreOptions(options.request, turn),
      ...(initialPrompts === undefined ? {} : { initialPrompts }),
      ...(options.session.signal === undefined
        ? {}
        : { signal: options.session.signal }),
      // Translated rather than forwarded, though the browser's monitor would
      // satisfy `DownloadMonitor` as it stands: going through the lifecycle's
      // own is what applies the never-decreasing rule to every backend alike.
      monitor: (monitor) => {
        monitor.ondownloadprogress = (event) => {
          const progress = fraction(
            event.total === 0 ? 0 : event.loaded / event.total,
          );
          if (progress !== null) options.reportProgress(progress);
        };
      },
    });
    // Forwarded, not re-derived: by the time a listener reads the counters the
    // dropped turns are gone, and `used` can be back under the window.
    session.oncontextoverflow = () => {
      options.reportOverflow();
    };
    return ok(new PromptApiModel(session, turn));
  } catch (error) {
    return err(failureFromError(error));
  }
};

export function makePromptApiProvider(): AiProvider {
  const backend: ModelBackend = {
    name: "prompt-api",
    // Text only, because that is all `AiMessage` carries. The model takes more,
    // and asking for it would promise a message this contract cannot build.
    modalities: ["text"],
    // The platform executes them itself; whether a given Chrome will open such
    // a session is its `create` to refuse, and that refusal is what `open` returns.
    tools: true,
    availability: (request) => getAvailability(request),
    connect: (options) => connectPromptApi(options),
  };
  return createProvider(backend);
}
