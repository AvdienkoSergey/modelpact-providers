/**
 * The contract suite, imported from `modelpact/testing` and pointed at a
 * backend written against nothing but `modelpact/backend`.
 *
 * The engine is stood in for. A real one downloads several hundred megabytes
 * into browser storage and then wants a GPU, neither of which a node run has,
 * so what is under test here is the adapter and the shape of the public API
 * that let it be written at all.
 *
 * If this file compiles and passes, a third party can write a backend with
 * nothing but the published entry points. That is the whole experiment.
 */

import { describe, expect, test } from "vitest";
import { describeContract } from "modelpact/testing";

import {
  makeWebGpuProvider,
  type EngineChunk,
  type EngineRequest,
  type WebGpuEngine,
} from "./webgpu.js";

const MODEL = "Stub-0.5B-MLC";

interface StubOptions {
  readonly reply?: string;
  readonly usedTokens?: number;
  readonly failWith?: () => never;
  readonly steps?: readonly number[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Deltas the way the engine sends them: word by word, usage on the last one. */
async function* makeEngineChunks(
  text: string,
  usedTokens: number,
): AsyncGenerator<EngineChunk> {
  const words = text.match(/\S+\s*/g) ?? [text];
  for (const word of words) {
    await sleep(1);
    yield { choices: [{ delta: { content: word } }] };
  }
  yield { choices: [{ delta: {} }], usage: { total_tokens: usedTokens } };
}

/** Typed as what the backend needs and not cast: the stub is held to the same shape the real engine is. */
const makeStubEngine = (options: StubOptions): WebGpuEngine => ({
  chat: {
    completions: {
      create: (request: EngineRequest) => {
        options.failWith?.();
        const askedText = request.messages.at(-1)?.content ?? "";
        // Prose unless a schema was asked for, as a real engine does: a
        // constrained answer is one word and would fail "more than one delta"
        // for a reason that says nothing about the backend.
        const answerText =
          request.response_format === undefined
            ? `Answering «${askedText}» at some length, in several words.`
            : (options.reply ?? "{}");
        const usedTokens = options.usedTokens ?? answerText.split(/\s+/).length;
        return Promise.resolve(makeEngineChunks(answerText, usedTokens));
      },
    },
  },
  unload: () => Promise.resolve(),
  interruptGenerate: () => undefined,
});

const makeStubbedProvider = (
  options: StubOptions = {},
  contextWindow?: number,
) =>
  makeWebGpuProvider({
    model: MODEL,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    engine: async (reportProgress) => {
      for (const step of options.steps ?? []) {
        await sleep(0);
        reportProgress(step);
      }
      return makeStubEngine(options);
    },
  });

describeContract("webgpu", (scenario) => {
  switch (scenario) {
    case "ready":
      return makeStubbedProvider({ reply: JSON.stringify({ city: "Paris" }) });
    case "unavailable":
      // `navigator.gpu` is what decides it, and node has no navigator at all,
      // so this is the one scenario that needs no stub.
      return makeWebGpuProvider({ model: MODEL });
    case "needs-download":
      // The engine hook answers `ready`, so the branch cannot be staged from
      // out here without a browser cache to empty.
      return null;
    case "tiny-window":
      return makeStubbedProvider(
        { reply: JSON.stringify({ city: "Paris" }) },
        1,
      );
  }
});

describe("webgpu from outside", () => {
  test("no WebGPU is a refusal that names the vocabulary", async () => {
    const access = await makeWebGpuProvider({ model: MODEL }).access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("unsupported-config");
  });

  test("the engine's own throw comes back as a Result", async () => {
    const provider = makeStubbedProvider({
      failWith: () => {
        throw new Error("no adapter");
      },
    });
    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    const answerResult = await sessionResult.value.prompt("hello");
    expect(answerResult.ok).toBe(false);
    // `failureFromError` comes through the door, so a backend in this package
    // maps its exceptions with the same table the lifecycle uses.
    if (!answerResult.ok) expect(typeof answerResult.error.kind).toBe("string");
    sessionResult.value.close();
  });

  test("usage comes from the engine's own count", async () => {
    const provider = makeStubbedProvider(
      { reply: "two words", usedTokens: 40 },
      100,
    );
    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open();
    if (!sessionResult.ok) throw new Error("expected a session");

    await sessionResult.value.prompt("hello");
    const usage = sessionResult.value.usage();
    expect(usage.kind).toBe("bounded");
    if (usage.kind === "bounded") {
      expect(usage.used).toBe(40);
      expect(usage.remaining).toBe(60);
    }
    sessionResult.value.close();
  });
});
