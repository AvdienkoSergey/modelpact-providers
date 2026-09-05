/**
 * A model in the tab itself, on WebGPU, through `@mlc-ai/web-llm`.
 *
 * `modelpact/backend` is the whole of what it reaches for, so if a backend
 * cannot be built from what that door exports, this file is where it shows.
 * It was written before this package existed, in a directory one repository
 * over, to ask exactly that — and it needed nothing added to the contract.
 *
 * What the engine brings that the other backends do not: the download is the
 * page's own, several hundred megabytes into browser storage, and it is the
 * only one where `needs-download` costs the user their bandwidth rather than a
 * daemon's.
 */

import {
  contextUsage,
  createProvider,
  err,
  failureFromError,
  fraction,
  ok,
  tokens,
  type AiFailure,
  type AiProvider,
  type Availability,
  type ConnectOptions,
  type ContextUsage,
  type GenerateRequest,
  type ModelConnection,
  type ModelBackend,
  type Result,
} from "modelpact/backend";
import { CreateMLCEngine, type InitProgressReport } from "@mlc-ai/web-llm";

/** A delta as the engine sends it; these are the only fields read. */
export interface EngineChunk {
  readonly choices: readonly {
    readonly delta: { readonly content?: string | null };
  }[];
  readonly usage?: { readonly total_tokens: number } | null;
}

export interface EngineRequest {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }[];
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly response_format?: {
    readonly type: "json_object";
    readonly schema: string;
  };
}

/**
 * What this backend uses of the engine, which is less than the engine has.
 *
 * Named here and not imported, so that the emitted declarations name nothing
 * from `@mlc-ai/web-llm`. Its own `.d.ts` files reference packages it does not
 * depend on, and a consumer with `skipLibCheck` off inherits that break through
 * a type they never asked for — the demo did, the moment it started resolving
 * this package the way npm would. The Prompt API backend next door keeps
 * `LanguageModel` out of its own declarations for the same reason.
 *
 * Method syntax on purpose: it is bivariant, which is what lets the real
 * engine, with its overloads and wider request type, satisfy this narrower one
 * without restating all of it.
 */
export interface WebGpuEngine {
  readonly chat: {
    readonly completions: {
      create(request: EngineRequest): Promise<AsyncIterable<EngineChunk>>;
    };
  };
  unload(): Promise<void>;
  interruptGenerate(): void;
}

export interface WebGpuConfig {
  /** A tag from the engine's own catalogue, such as `SmolLM2-360M-Instruct-q4f16_1-MLC`. */
  readonly model: string;
  /** Tokens the session is measured against; the engine reports no window of its own. */
  readonly contextWindow?: number;
  /** For a test: an engine already built, instead of one loaded from the network. */
  readonly engine?: (
    reportProgress: (progress: number) => void,
  ) => Promise<WebGpuEngine>;
}

const DEFAULTS = { contextWindow: 4096 };

const ZERO_TOKENS = tokens(0) ?? (0 as never);

/** WebGPU or nothing: the engine has a WASM path, but not one worth offering. */
const hasWebGpu = (): boolean =>
  typeof navigator !== "undefined" && "gpu" in navigator;

/**
 * Weights live in the browser's cache, so "downloaded" is a question about
 * this profile rather than about the machine. The engine exposes no such
 * check, so the cache is asked directly.
 */
const isCached = async (model: string): Promise<boolean> => {
  if (typeof caches === "undefined") return false;
  try {
    const cacheNames = await caches.keys();
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const cachedRequests = await cache.keys();
      if (cachedRequests.some((request) => request.url.includes(model)))
        return true;
    }
    return false;
  } catch {
    return false;
  }
};

const getAvailability = async (config: WebGpuConfig): Promise<Availability> => {
  if (config.engine !== undefined) return { kind: "ready" };
  if (!hasWebGpu()) {
    return {
      kind: "unavailable",
      reason: { kind: "unsupported-config", languages: [], modalities: [] },
    };
  }
  const isModelCached = await isCached(config.model);
  return isModelCached
    ? { kind: "ready" }
    : { kind: "needs-download", started: false };
};

/** The engine reports a stage and a percentage; only the number is ours to pass on. */
const readProgress = (initReport: InitProgressReport): number =>
  typeof initReport.progress === "number" ? initReport.progress : 0;

class WebGpuConnection implements ModelConnection {
  readonly #engine: WebGpuEngine;
  readonly #model: string;
  readonly #contextWindow: number;
  readonly #system: string | undefined;
  #usedTokens = 0;

  constructor(
    engine: WebGpuEngine,
    config: WebGpuConfig,
    options: ConnectOptions,
  ) {
    this.#engine = engine;
    this.#model = config.model;
    this.#contextWindow = config.contextWindow ?? DEFAULTS.contextWindow;
    this.#system = options.session.system;
  }

  readonly generateStream = async (
    input: string,
    request: GenerateRequest,
  ): Promise<Result<ReadableStream<string>, AiFailure>> => {
    try {
      const chunks = await this.#engine.chat.completions.create({
        model: this.#model,
        messages: this.#toEngineMessages(input, request),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.schema === undefined
          ? {}
          : {
              response_format: {
                type: "json_object",
                schema: JSON.stringify(request.schema),
              },
            }),
      });
      return ok(this.#toDeltaStream(chunks));
    } catch (error) {
      return err(failureFromError(error));
    }
  };

  readonly usage = (): ContextUsage =>
    contextUsage(tokens(this.#usedTokens) ?? ZERO_TOKENS, this.#contextWindow);

  readonly dispose = (): void => {
    void this.#engine.unload();
  };

  #toEngineMessages(input: string, request: GenerateRequest) {
    const historyMessages = request.history.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const askedMessage = { role: "user" as const, content: input };
    return this.#system === undefined
      ? [...historyMessages, askedMessage]
      : [
          { role: "system" as const, content: this.#system },
          ...historyMessages,
          askedMessage,
        ];
  }

  /**
   * An async iterable into a `ReadableStream`, because that is what the
   * contract carries.
   *
   * The abort is deliberately not policed here. The lifecycle checks the signal
   * around every read and errors the stream itself, in the vocabulary; a
   * backend that raced it to the punch with a plain `Error` would land in
   * `unknown` instead of `aborted`, which is what the conformance suite caught
   * when this file did exactly that.
   *
   * What is left to do is tell the engine, since it takes no signal of its own:
   * `cancel` reaches every way out — the reader stopping, the abort, the close.
   */
  #toDeltaStream(chunks: AsyncIterable<EngineChunk>): ReadableStream<string> {
    const iterator = chunks[Symbol.asyncIterator]();
    return new ReadableStream<string>({
      // Loops until it can enqueue or close: a pull that returns empty-handed
      // is not called again unless a read arrived meanwhile, and the engine
      // sends chunks with no text — the usage one, a stop one — back to back.
      // Found in the sibling package on `claude -p`, fixed here before it bit.
      pull: async (controller) => {
        for (;;) {
          const iteration = await iterator.next();
          if (iteration.done === true) {
            controller.close();
            return;
          }
          const chunk = iteration.value;
          if (chunk.usage != null) this.#usedTokens = chunk.usage.total_tokens;
          const delta = chunk.choices[0]?.delta.content ?? "";
          if (delta !== "") {
            controller.enqueue(delta);
            return;
          }
        }
      },
      cancel: async () => {
        this.#engine.interruptGenerate();
        await iterator.return?.();
      },
    });
  }
}

/**
 * The real engine behind `WebGpuEngine`. An adapter and not a cast: the real
 * `create` is an overload set, and an overload set is not assignable to a
 * single signature even when one member fits — so each call is written out,
 * and the compiler resolves the streaming overload from `stream: true` and
 * checks our request shape against it. Nothing here is asserted.
 */
const loadEngine = async (
  model: string,
  reportProgress: (progress: number) => void,
): Promise<WebGpuEngine> => {
  const realEngine = await CreateMLCEngine(model, {
    initProgressCallback: (initReport) => {
      reportProgress(readProgress(initReport));
    },
  });
  return {
    chat: {
      completions: {
        // A fresh array: ours is `readonly`, which is right for a request
        // nobody should edit, and the engine's signature wants a mutable one.
        create: (request) =>
          realEngine.chat.completions.create({
            ...request,
            messages: [...request.messages],
          }),
      },
    },
    unload: () => realEngine.unload(),
    interruptGenerate: () => {
      // The engine's own is a promise, though its published interface says
      // otherwise; dropped on purpose, and marked rather than left floating.
      // By the time this runs the lifecycle has already errored the stream as
      // `aborted`, so waiting for the engine to acknowledge would hold a turn
      // whose caller has been answered.
      void realEngine.interruptGenerate();
    },
  };
};

const connectEngine = async (
  config: WebGpuConfig,
  options: ConnectOptions,
): Promise<Result<ModelConnection, AiFailure>> => {
  const reportProgress = (progress: number): void => {
    const progressFraction = fraction(progress);
    if (progressFraction !== null) options.reportProgress(progressFraction);
  };
  try {
    const engine =
      config.engine === undefined
        ? await loadEngine(config.model, reportProgress)
        : await config.engine(reportProgress);
    return ok(new WebGpuConnection(engine, config, options));
  } catch (error) {
    return err(failureFromError(error));
  }
};

export function makeWebGpuProvider(config: WebGpuConfig): AiProvider {
  const backend: ModelBackend = {
    name: "webgpu",
    modalities: ["text"],
    availability: () => getAvailability(config),
    connect: (options) => connectEngine(config, options),
  };
  return createProvider(backend);
}
