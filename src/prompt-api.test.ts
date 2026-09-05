/**
 * The adapter, against a `LanguageModel` written here.
 *
 * The real one is a browser and a downloaded model, so a node run cannot reach
 * it, and what stays here is every branch of the mapping, made to happen on
 * demand. The fake is not a convenience — it is the list of what this backend
 * needs from the platform, and nothing else is allowed to grow past it.
 *
 * The fake goes on `globalThis`, where the browser puts the real one, because
 * the backend takes no injection: a hatch for it would have named the platform
 * class in an exported type, and that name is one a consumer does not have.
 *
 * `access` against the missing global is the one case that is not a fake: in
 * node there is no `LanguageModel`, and that is the answer under test.
 */

import { afterEach, describe, expect, test } from "vitest";

import { makePromptApiProvider } from "./prompt-api.js";
import { CONTRACT_SCHEMA, describeContract } from "modelpact/testing";
import {
  jsonSchema,
  type AiProvider,
  type JsonSchema,
  type Tool,
} from "modelpact/backend";

const asSchema = (value: Record<string, unknown>): JsonSchema => {
  const schema = jsonSchema(value);
  if (schema === null) throw new Error("not a schema");
  return schema;
};

interface FakeOptions {
  readonly availability?: Awaited<
    ReturnType<typeof LanguageModel.availability>
  >;
  /** Thrown from `availability`, from `create`, or from a turn. */
  readonly failCreate?: () => never;
  readonly failPrompt?: () => never;
  readonly downloadSteps?: readonly number[];
  readonly contextWindow?: number;
  /** Absent, the fake answers by echoing; present, it answers this. */
  readonly schemaReply?: string;
  readonly delayMs?: number;
  /** `create` throws InvalidStateError when tools are handed over, as Chrome 152 does. */
  readonly refuseTools?: boolean;
  /** A rejected `execute` is swallowed and the answer goes on, to stand in for a browser that does that. */
  readonly swallowToolErrors?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough that a second call lands while the first is still running. */
const generateReply = (input: string): string[] => {
  const sentence = `Answering «${input.slice(0, 40)}» at some length. `;
  return sentence.match(/\S+\s*/g) ?? ["Answer."];
};

const countWords = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

/**
 * A stand-in for the platform's class: the same statics, the same session
 * shape, the same exceptions by `name`, which is all `failureFromError` reads.
 */
function makeFakeLanguageModel(
  options: FakeOptions = {},
): typeof LanguageModel {
  const windowSize = options.contextWindow ?? 4096;
  const delayMs = options.delayMs ?? 1;

  class FakeSession extends EventTarget {
    contextUsage = 0;
    readonly contextWindow = windowSize;
    oncontextoverflow: ((event: Event) => void) | null = null;
    #destroyed = false;
    #fired = false;
    readonly #tools: readonly LanguageModelTool[];

    constructor(
      initialMessages: readonly { content: string }[],
      tools: readonly LanguageModelTool[],
    ) {
      super();
      this.#tools = tools;
      for (const message of initialMessages)
        this.contextUsage += countWords(message.content);
      // Loaded into the window at create, as the spec has it.
      for (const tool of tools)
        this.contextUsage += countWords(`${tool.name} ${tool.description}`);
    }

    async prompt(
      input: string,
      callOptions?: { signal?: AbortSignal; responseConstraint?: unknown },
    ): Promise<string> {
      const stream = this.promptStreaming(input, callOptions);
      const reader = stream.getReader();
      const answerParts: string[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return answerParts.join("");
        answerParts.push(chunk.value);
      }
    }

    promptStreaming(
      input: string,
      callOptions?: { signal?: AbortSignal; responseConstraint?: unknown },
    ): ReadableStream<string> {
      if (this.#destroyed) throw abortError("the session is destroyed");
      options.failPrompt?.();
      const signal = callOptions?.signal;
      if (signal?.aborted === true) throw abortError("aborted");
      const isConstrained = callOptions?.responseConstraint !== undefined;
      if (isConstrained && options.schemaReply === undefined)
        throw namedError("NotSupportedError", "no constraint support");
      const replyParts = isConstrained
        ? [options.schemaReply ?? ""]
        : generateReply(input);
      // A tool named in the input is called with the model's arguments, and
      // what it said is the last delta — the platform's `execute` seen from
      // the outside, without a model deciding anything.
      const namedTools = this.#tools.filter((tool) =>
        input.includes(tool.name),
      );
      let toolParts: string[] | null = null;

      let index = 0;
      return new ReadableStream<string>({
        pull: async (controller) => {
          await sleep(delayMs);
          if (signal?.aborted === true || this.#destroyed) {
            controller.error(abortError("aborted"));
            return;
          }
          if (toolParts === null) {
            toolParts = [];
            for (const tool of namedTools) {
              try {
                toolParts.push(await tool.execute({ item: "kettle" }));
              } catch (error) {
                if (options.swallowToolErrors !== true) {
                  controller.error(error);
                  return;
                }
              }
            }
            replyParts.push(...toolParts);
          }
          const part = replyParts[index];
          if (part === undefined) {
            this.#charge(input, replyParts.join(""));
            controller.close();
            return;
          }
          index += 1;
          controller.enqueue(part);
        },
      });
    }

    destroy(): void {
      this.#destroyed = true;
    }

    #charge(input: string, answer: string): void {
      this.contextUsage += countWords(input) + countWords(answer);
      if (this.contextUsage <= this.contextWindow || this.#fired) return;
      // The browser fires its own; forwarding it is what this exercises.
      this.#fired = true;
      this.oncontextoverflow?.(new Event("contextoverflow"));
    }
  }

  return {
    availability: () => {
      options.failCreate?.();
      return Promise.resolve(options.availability ?? "available");
    },
    create: async (createOptions?: LanguageModelCreateOptions) => {
      options.failCreate?.();
      if (createOptions?.signal?.aborted === true) throw abortError("aborted");
      const tools = createOptions?.tools ?? [];
      if (tools.length > 0 && options.refuseTools === true)
        throw namedError(
          "InvalidStateError",
          "The device is unable to create a session to run the model.",
        );
      // Before any await, as the spec requires and the contract asserts.
      createOptions?.monitor?.(
        makeReportingMonitor(options.downloadSteps ?? []),
      );
      await sleep(0);
      const initialPrompts = createOptions?.initialPrompts ?? [];
      const carriedMessages = [...initialPrompts].filter(
        (message) =>
          message.role !== "system" && typeof message.content === "string",
      ) as { content: string }[];
      return new FakeSession(
        carriedMessages,
        tools,
      ) as unknown as LanguageModel;
    },
  } as unknown as typeof LanguageModel;
}

/** The platform's monitor: an EventTarget that has already fired by the time `create` awaits. */
const makeReportingMonitor = (steps: readonly number[]): CreateMonitor => {
  const monitor = new EventTarget() as CreateMonitor & {
    ondownloadprogress: ((event: ProgressEvent) => void) | null;
  };
  monitor.ondownloadprogress = null;
  queueMicrotask(() => {
    for (const step of steps) {
      const event = Object.assign(new Event("downloadprogress"), {
        loaded: step,
        total: 1,
        lengthComputable: true,
      }) as unknown as ProgressEvent;
      monitor.ondownloadprogress?.(event);
    }
  });
  return monitor;
};

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const abortError = (message: string): Error =>
  namedError("AbortError", message);

const SCHEMA_REPLY = JSON.stringify({ city: "Paris" });

const makeLookupTool = (execute: Tool["execute"]): Tool => ({
  name: "lookupColour",
  description: "Return the colour recorded for an item name.",
  inputSchema: asSchema({ type: "object" }),
  execute,
});

const globalScope = globalThis as { LanguageModel?: typeof LanguageModel };

/** Installs the fake and hands back a provider that will find it. */
const makeFakeProvider = (options: FakeOptions = {}): AiProvider => {
  globalScope.LanguageModel = makeFakeLanguageModel(options);
  return makePromptApiProvider();
};

afterEach(() => {
  delete globalScope.LanguageModel;
});

describeContract("prompt-api on a written LanguageModel", (scenario) => {
  switch (scenario) {
    case "ready":
      return makeFakeProvider({ schemaReply: SCHEMA_REPLY });
    case "unavailable":
      return makeFakeProvider({ availability: "unavailable" });
    case "needs-download":
      return makeFakeProvider({
        availability: "downloadable",
        downloadSteps: [0, 0.5, 1],
      });
    case "tiny-window":
      return makeFakeProvider({
        contextWindow: 1,
        schemaReply: SCHEMA_REPLY,
      });
  }
});

describe("prompt-api mapping", () => {
  test("no global at all is unsupported, not a crash", async () => {
    // Node has no `LanguageModel`, and this is the one case with nothing faked.
    const access = await makePromptApiProvider().access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("unsupported");
  });

  test("`downloading` is the same branch as `downloadable`, and says so", async () => {
    const provider = makeFakeProvider({ availability: "downloading" });
    const access = await provider.access();
    expect(access.kind).toBe("needs-download");
    if (access.kind !== "needs-download") return;
    // The only difference a caller can act on: somebody is already fetching.
    expect(access.started).toBe(true);
  });

  test("a blocked permissions policy is a reason, not an exception", async () => {
    const provider = makeFakeProvider({
      failCreate: () => {
        throw namedError(
          "NotAllowedError",
          "language-model is not allowed here",
        );
      },
    });
    const access = await provider.access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("not-allowed");
  });

  test("an overflow the browser announces is forwarded, once", async () => {
    const provider = makeFakeProvider({ contextWindow: 1 });
    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    let fired = 0;
    sessionResult.value.oncontextoverflow = () => (fired += 1);
    await sessionResult.value.prompt("one");
    await sessionResult.value.prompt("two");
    expect(fired).toBe(1);
    sessionResult.value.close();
  });

  test("a quota exception comes back carrying the reading", async () => {
    const provider = makeFakeProvider({
      contextWindow: 500,
      failPrompt: () => {
        throw namedError("QuotaExceededError", "over the window");
      },
    });
    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    const answerResult = await sessionResult.value.prompt("hello");
    expect(answerResult.ok).toBe(false);
    if (answerResult.ok) return;
    expect(answerResult.error.kind).toBe("context-overflow");
    // The generic mapping cannot fill this in; holding the session is what can.
    if (answerResult.error.kind === "context-overflow")
      expect(answerResult.error.usage.kind).toBe("bounded");
    sessionResult.value.close();
  });

  test("a schema it cannot constrain is refused, never answered in prose", async () => {
    const provider = makeFakeProvider();
    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    const answerResult = await sessionResult.value.prompt(
      "Name the capital of France.",
      { schema: CONTRACT_SCHEMA },
    );
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok)
      expect(answerResult.error.kind).toBe("unsupported-config");
    sessionResult.value.close();
  });

  test("the system turn goes in first, and the history after it", async () => {
    let seenCreateOptions: LanguageModelCreateOptions | undefined;
    const api = makeFakeLanguageModel();
    const watchedApi = {
      availability: api.availability.bind(api),
      create: (createOptions?: LanguageModelCreateOptions) => {
        seenCreateOptions = createOptions;
        return api.create(createOptions);
      },
    } as unknown as typeof LanguageModel;

    globalScope.LanguageModel = watchedApi;
    const access = await makePromptApiProvider().access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open({
      system: "Answer in one sentence.",
      history: [{ role: "user", content: "earlier" }],
    });
    if (!sessionResult.ok) throw new Error("expected a session");

    expect(seenCreateOptions?.initialPrompts).toEqual([
      { role: "system", content: "Answer in one sentence." },
      { role: "user", content: "earlier" },
    ]);
    sessionResult.value.close();
  });

  test("tools go to create, with a tool-call output expected", async () => {
    let seenCreateOptions: LanguageModelCreateOptions | undefined;
    const api = makeFakeLanguageModel();
    globalScope.LanguageModel = {
      availability: api.availability.bind(api),
      create: (createOptions?: LanguageModelCreateOptions) => {
        seenCreateOptions = createOptions;
        return api.create(createOptions);
      },
    } as unknown as typeof LanguageModel;

    const access = await makePromptApiProvider().access({
      outputs: [{ type: "text", languages: ["en"] }],
      tools: [makeLookupTool(() => "teal")],
    });
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    expect(seenCreateOptions?.tools?.map((tool) => tool.name)).toEqual([
      "lookupColour",
    ]);
    // Chrome 152 refuses the session otherwise, whatever the spec text says.
    expect(seenCreateOptions?.expectedOutputs).toEqual([
      { type: "text", languages: ["en"] },
      { type: "tool-call" },
    ]);
    sessionResult.value.close();
  });

  test("a create that refuses tools is a refusal at open, not at access", async () => {
    const provider = makeFakeProvider({ refuseTools: true });
    const access = await provider.access({
      tools: [makeLookupTool(() => "teal")],
    });
    expect(access.kind).toBe("ready");
    if (access.kind !== "ready") return;
    const sessionResult = await access.open();
    expect(sessionResult.ok).toBe(false);
    if (!sessionResult.ok)
      expect(sessionResult.error.kind).toBe("invalid-state");
  });

  test("a tool's failure ends the turn even when the browser swallows it", async () => {
    const provider = makeFakeProvider({ swallowToolErrors: true });
    const access = await provider.access({
      tools: [
        makeLookupTool(() => {
          throw new Error("the record is locked");
        }),
      ],
    });
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    const answerResult = await sessionResult.value.prompt(
      "Use lookupColour for the kettle.",
    );
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) expect(answerResult.error.kind).toBe("failed");
    sessionResult.value.close();
  });
});
