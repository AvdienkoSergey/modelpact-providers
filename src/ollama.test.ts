/**
 * Two halves. The contract suite runs against a daemon if one answers, and
 * skips loudly if none does — a skip is in the run output, a silent pass is
 * not. The tests under it run always, on a `fetch` that answers from strings:
 * a download, a daemon that is not there, and the errors a real one returns
 * are none of them stageable on a machine where everything works.
 */

import { describe, expect, test, vi } from "vitest";

import { makeOllamaProvider, type OllamaConfig } from "./ollama.js";
import { CONTRACT_SCHEMA, describeContract } from "modelpact/testing";
import { jsonSchema, type JsonSchema, type Tool } from "modelpact/backend";

const asSchema = (value: Record<string, unknown>): JsonSchema => {
  const schema = jsonSchema(value);
  if (schema === null) throw new Error("not a schema");
  return schema;
};

// The model answers in a second or two, but the first call of a run loads it.
vi.setConfig({ testTimeout: 60_000 });

// Written out rather than read from the environment: `process` is kept out of
// tsconfig's `types` on purpose, so browser-side code cannot reach for it by
// accident. The `ollama` job in CI pins the same two.
const HOST = "http://127.0.0.1:11434";
const MODEL = "granite4:350m";

/** Nothing listens on port 1, and refusing is quick. */
const NOWHERE = "http://127.0.0.1:1";

const isDaemonAnswering = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${HOST}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const listedBody: unknown = await response.json();
    const models =
      (listedBody as { models?: { model?: string }[] }).models ?? [];
    return models.some((entry) => entry.model === MODEL);
  } catch {
    return false;
  }
};

const isReachable = await isDaemonAnswering();

describeContract("ollama", (scenario) => {
  if (!isReachable) return null;
  switch (scenario) {
    case "ready":
      return makeOllamaProvider({ model: MODEL, host: HOST });
    case "unavailable":
      return makeOllamaProvider({ model: MODEL, host: NOWHERE });
    case "needs-download":
      // Staging it means the model is absent, and opening then downloads it
      // for real. The stubbed run below walks the same branch for nothing.
      return null;
    case "tiny-window":
      // Under one turn of `num_ctx`, so the first answer crosses the line.
      return makeOllamaProvider({
        model: MODEL,
        host: HOST,
        contextWindow: 64,
      });
  }
});

/** `String(request)` is `[object Object]`; the url lives in one of three places. */
const toUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

/** Everything this backend sends is a JSON string, and nothing else is read. */
const readSentBody = (
  init: RequestInit | undefined,
): Record<string, unknown> =>
  typeof init?.body === "string"
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : {};

/** A daemon made of strings: each call answers from the first matching rule. */
const makeDaemon =
  (
    routes: Record<string, (init: RequestInit | undefined) => Response>,
  ): NonNullable<OllamaConfig["fetch"]> =>
  (input, init) => {
    const url = toUrl(input);
    for (const [path, respond] of Object.entries(routes)) {
      if (url.includes(path)) return Promise.resolve(respond(init));
    }
    return Promise.reject(new Error(`nothing routed for ${url}`));
  };

const makeJsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeNdjsonResponse = (...lines: unknown[]): Response =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    status: 200,
  });

const makeTagsResponse = (...models: string[]): Response =>
  makeJsonResponse({ models: models.map((model) => ({ model })) });

/**
 * Both shapes the daemon has, chosen the way it chooses: `stream: true` is
 * NDJSON ending on the line that carries the counts, `stream: false` is one
 * object. A stub that answered the same either way would hide which of
 * `generateStream` and `generateWhole` the lifecycle took.
 */
const makeChatResponse =
  (...deltas: string[]) =>
  (init: RequestInit | undefined): Response => {
    const counts = { prompt_eval_count: 30, eval_count: deltas.length };
    const wholeBody = {
      message: { content: deltas.join("") },
      done: true,
      ...counts,
    };
    if (readSentBody(init).stream !== true) return makeJsonResponse(wholeBody);
    return makeNdjsonResponse(
      ...deltas.map((content) => ({ message: { content }, done: false })),
      { message: { content: "" }, done: true, ...counts },
    );
  };

/** A round the daemon ends in a call, streamed the way it streams one: the call on one line, the counts on the last. */
const makeToolCallResponse = (
  name: string,
  callArguments: Record<string, unknown>,
): Response =>
  makeNdjsonResponse(
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { index: 0, name, arguments: callArguments } },
        ],
      },
      done: false,
    },
    {
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: 40,
      eval_count: 12,
    },
  );

const makeLookupTool = (execute: Tool["execute"]): Tool => ({
  name: "lookupColour",
  description: "Return the colour recorded for an item name.",
  inputSchema: asSchema({
    type: "object",
    properties: { item: { type: "string" } },
    required: ["item"],
  }),
  execute,
});

/** A daemon whose chat answers come from a script, one per round, in order. */
const makeScriptedProvider = (
  rounds: readonly ((init: RequestInit | undefined) => Response)[],
  sentBodies: Record<string, unknown>[],
  config: Partial<OllamaConfig> = {},
) =>
  makeOllamaProvider({
    model: MODEL,
    host: HOST,
    ...config,
    fetch: (input, init) => {
      const url = toUrl(input);
      if (url.includes("/api/tags"))
        return Promise.resolve(makeTagsResponse(MODEL));
      sentBodies.push(readSentBody(init));
      const respond =
        rounds[sentBodies.length - 1] ?? rounds[rounds.length - 1];
      if (respond === undefined) throw new Error("no rounds scripted");
      return Promise.resolve(respond(init));
    },
  });

const mustOpenWithTool = async (
  provider: ReturnType<typeof makeStubbedProvider>,
  tool: Tool,
) => {
  const access = await provider.access({ tools: [tool] });
  if (access.kind !== "ready")
    throw new Error(`expected ready, got ${access.kind}`);
  const sessionResult = await access.open();
  if (!sessionResult.ok)
    throw new Error(`open refused: ${sessionResult.error.kind}`);
  return sessionResult.value;
};

const makeStubbedProvider = (
  routes: Record<string, (init: RequestInit | undefined) => Response>,
  config: Partial<OllamaConfig> = {},
) =>
  makeOllamaProvider({
    model: MODEL,
    host: HOST,
    ...config,
    fetch: makeDaemon(routes),
  });

/**
 * A daemon that stops at the window instead of shifting it: the counts reach
 * `num_ctx` and go no further, and `done_reason` says why they stopped there.
 */
const makeStoppedAtWindowResponse =
  (doneReason: string) =>
  (init: RequestInit | undefined): Response => {
    const counts = {
      prompt_eval_count: 24,
      eval_count: 8,
      done_reason: doneReason,
    };
    const wholeBody = {
      message: { content: "one, two" },
      done: true,
      ...counts,
    };
    if (readSentBody(init).stream !== true) return makeJsonResponse(wholeBody);
    return makeNdjsonResponse(
      { message: { content: "one, two" }, done: false },
      { message: { content: "" }, done: true, ...counts },
    );
  };

const mustOpenSession = async (
  provider: ReturnType<typeof makeStubbedProvider>,
) => {
  const access = await provider.access();
  if (access.kind !== "ready")
    throw new Error(`expected ready, got ${access.kind}`);
  const sessionResult = await access.open();
  if (!sessionResult.ok)
    throw new Error(`open refused: ${sessionResult.error.kind}`);
  return sessionResult.value;
};

describe("ollama without a daemon", () => {
  test("nothing listening is unavailable, not a failed request", async () => {
    const provider = makeOllamaProvider({ model: MODEL, host: NOWHERE });
    const access = await provider.access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("unsupported");
  });

  test("a model the daemon does not have needs downloading", async () => {
    const provider = makeStubbedProvider({
      "/api/tags": () => makeTagsResponse("something:else"),
    });
    const access = await provider.access();
    expect(access.kind).toBe("needs-download");
  });

  test("the download reports progress, reaches one, and opens", async () => {
    const provider = makeStubbedProvider({
      "/api/tags": () => makeTagsResponse("something:else"),
      "/api/pull": () =>
        makeNdjsonResponse(
          { status: "pulling manifest" },
          { status: "pulling a", digest: "a", total: 100, completed: 40 },
          { status: "pulling a", digest: "a", total: 100, completed: 100 },
          // A second layer announced late: the denominator grows, so the share
          // would step back and the monitor drops it rather than rewind.
          { status: "pulling b", digest: "b", total: 100, completed: 0 },
          { status: "pulling b", digest: "b", total: 100, completed: 100 },
          { status: "success" },
        ),
      "/api/chat": makeChatResponse("done"),
    });

    const access = await provider.access();
    if (access.kind !== "needs-download")
      throw new Error("expected a download");
    const seenProgress: number[] = [];
    const sessionResult = await access.open((monitor) => {
      monitor.ondownloadprogress = (event) => seenProgress.push(event.loaded);
    });

    expect(seenProgress.length).toBeGreaterThan(1);
    expect(seenProgress).toEqual([...seenProgress].sort((a, b) => a - b));
    expect(seenProgress.at(-1)).toBe(1);
    expect(sessionResult.ok).toBe(true);
    if (sessionResult.ok) sessionResult.value.close();
  });

  test("a refused pull is a failure, not a session", async () => {
    const provider = makeStubbedProvider({
      "/api/tags": () => makeTagsResponse("something:else"),
      "/api/pull": () =>
        new Response(JSON.stringify({ error: "file does not exist" }), {
          status: 500,
        }),
    });
    const access = await provider.access();
    if (access.kind !== "needs-download")
      throw new Error("expected a download");
    const sessionResult = await access.open(() => undefined);
    expect(sessionResult.ok).toBe(false);
    if (sessionResult.ok) return;
    expect(sessionResult.error.kind).toBe("failed");
    if (sessionResult.error.kind === "failed")
      expect(sessionResult.error.detail).toContain("file does not exist");
  });

  test("the daemon's own words survive the mapping", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        "/api/tags": () => makeTagsResponse(MODEL),
        "/api/chat": () =>
          new Response(JSON.stringify({ error: "model is required" }), {
            status: 400,
          }),
      }),
    );
    const answerResult = await session.prompt("hello");
    expect(answerResult.ok).toBe(false);
    if (answerResult.ok) return;
    // 400 is this side reading badly; the detail is what the daemon said.
    expect(answerResult.error.kind).toBe("invalid-input");
    if (answerResult.error.kind === "invalid-input")
      expect(answerResult.error.detail).toBe("model is required");
  });

  test("the whole conversation goes out, with this turn last", async () => {
    const sentBodies: unknown[] = [];
    const provider = makeOllamaProvider({
      model: MODEL,
      host: HOST,
      fetch: (input, init) => {
        const url = toUrl(input);
        if (url.includes("/api/tags"))
          return Promise.resolve(makeTagsResponse(MODEL));
        sentBodies.push(readSentBody(init));
        return Promise.resolve(makeChatResponse("ok")(init));
      },
    });

    const session = await mustOpenSession(provider);
    await session.prompt("first");
    await session.prompt("second");
    const secondBody = sentBodies[1] as {
      messages: { role: string; content: string }[];
    };
    expect(secondBody.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);
    session.close();
  });

  test("a schema travels as `format`, which constrains decoding", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeOllamaProvider({
      model: MODEL,
      host: HOST,
      fetch: (input, init) => {
        const url = toUrl(input);
        if (url.includes("/api/tags"))
          return Promise.resolve(makeTagsResponse(MODEL));
        sentBodies.push(readSentBody(init));
        return Promise.resolve(makeChatResponse('{"city":"Paris"}')(init));
      },
    });

    const session = await mustOpenSession(provider);
    await session.prompt("Name the capital of France.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(sentBodies[0]?.format).toEqual(CONTRACT_SCHEMA);
    session.close();
  });

  test("the counts are what the window holds, not a running sum", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        "/api/tags": () => makeTagsResponse(MODEL),
        "/api/chat": makeChatResponse("a", "b"),
      }),
    );
    await session.prompt("first");
    const firstUsage = session.usage();
    await session.prompt("second");
    const secondUsage = session.usage();
    // Both turns report the same counts, and `prompt_eval_count` already holds
    // the history — so the meter repeats rather than doubling.
    expect(firstUsage).toEqual(secondUsage);
    if (firstUsage.kind === "bounded") expect(firstUsage.used).toBe(32);
    session.close();
  });

  test("a turn the daemon stopped at the window is an overflow", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider(
        {
          "/api/tags": () => makeTagsResponse(MODEL),
          "/api/chat": makeStoppedAtWindowResponse("length"),
        },
        { contextWindow: 32 },
      ),
    );
    let fired = 0;
    session.oncontextoverflow = () => (fired += 1);
    await session.prompt("first");
    // The counts stop exactly at the window, so nothing in them is over the
    // line: the daemon's `length` is the only thing that says the turn ran out.
    expect(fired).toBe(1);
    session.close();
  });

  test("a turn that ended on its own is not, at the same counts", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider(
        {
          "/api/tags": () => makeTagsResponse(MODEL),
          "/api/chat": makeStoppedAtWindowResponse("stop"),
        },
        { contextWindow: 32 },
      ),
    );
    let fired = 0;
    session.oncontextoverflow = () => (fired += 1);
    await session.prompt("first");
    expect(fired).toBe(0);
    session.close();
  });

  test("tools travel as functions, and a call comes back as a tool turn", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    let seenArguments: Record<string, unknown> | null = null;
    const provider = makeScriptedProvider(
      [
        () => makeToolCallResponse("lookupColour", { item: "kettle" }),
        makeChatResponse("teal"),
      ],
      sentBodies,
    );
    const session = await mustOpenWithTool(
      provider,
      makeLookupTool((input) => {
        seenArguments = input;
        return "teal";
      }),
    );

    const answerResult = await session.prompt("What colour is the kettle?");
    expect(answerResult.ok).toBe(true);
    if (answerResult.ok) expect(answerResult.value).toBe("teal");
    expect(seenArguments).toEqual({ item: "kettle" });
    expect(sentBodies[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookupColour",
          description: "Return the colour recorded for an item name.",
          parameters: {
            type: "object",
            properties: { item: { type: "string" } },
            required: ["item"],
          },
        },
      },
    ]);
    // The second round carries the call as the model's own turn and the
    // answer under the `tool` role, which is the shape the template renders.
    const secondMessages = (sentBodies[1] as { messages: unknown[] }).messages;
    expect(secondMessages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "lookupColour", arguments: { item: "kettle" } } },
        ],
      },
      { role: "tool", content: "teal", tool_name: "lookupColour" },
    ]);
    session.close();
  });

  test("a model that keeps calling is stopped with a reason", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [() => makeToolCallResponse("lookupColour", { item: "kettle" })],
      sentBodies,
      { maxToolRounds: 2 },
    );
    const session = await mustOpenWithTool(
      provider,
      makeLookupTool(() => "teal"),
    );

    const answerResult = await session.prompt("What colour is the kettle?");
    expect(answerResult.ok).toBe(false);
    if (!answerResult.ok) {
      expect(answerResult.error.kind).toBe("failed");
      if (answerResult.error.kind === "failed")
        expect(answerResult.error.detail).toContain("without answering");
    }
    // Two rounds were allowed, so three requests went out before the stop.
    expect(sentBodies).toHaveLength(3);
    session.close();
  });

  test("a name the model made up is answered by name, not by failing the turn", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [
        () => makeToolCallResponse("openSafe", { code: "1234" }),
        makeChatResponse("no such tool, sorry"),
      ],
      sentBodies,
    );
    const session = await mustOpenWithTool(
      provider,
      makeLookupTool(() => "teal"),
    );

    const answerResult = await session.prompt("Open the safe.");
    expect(answerResult.ok).toBe(true);
    const secondMessages = (sentBodies[1] as { messages: unknown[] }).messages;
    expect(secondMessages.at(-1)).toEqual({
      role: "tool",
      content: 'there is no tool called "openSafe"',
      tool_name: "openSafe",
    });
    session.close();
  });
});
