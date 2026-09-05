/**
 * Two halves, the same way the daemon's suite next door is split.
 *
 * The contract suite runs against a real OpenAI-compatible server if one
 * answers, and skips loudly if none does. The server it looks for by default is
 * Ollama's own compatibility layer on `/v1`, which is a genuine third-party
 * implementation of this dialect and already installed wherever the daemon
 * suite runs — any other would do, and `OPENAI_BASE_URL` is not read here for
 * the same reason the daemon's host is not: `process` is kept out of tsconfig's
 * `types` so browser-side code cannot reach for it by accident.
 *
 * The tests under it run always, on a `fetch` that answers from strings. They
 * are the things no working server will do on request: fragment a tool call
 * across frames the way OpenAI does and Ollama does not, omit a call id,
 * refuse a key, withhold `/models`, or stop a turn at the window.
 */

import { describe, expect, test, vi } from "vitest";

import { makeOpenAiProvider, type OpenAiConfig } from "./openai.js";
import { CONTRACT_SCHEMA, describeContract } from "modelpact/testing";
import { jsonSchema, type JsonSchema, type Tool } from "modelpact/backend";

const asSchema = (value: Record<string, unknown>): JsonSchema => {
  const schema = jsonSchema(value);
  if (schema === null) throw new Error("not a schema");
  return schema;
};

// The model answers in a second or two, but the first call of a run loads it.
vi.setConfig({ testTimeout: 60_000 });

const BASE_URL = "http://127.0.0.1:11434/v1";
const MODEL = "granite4:350m";

/** Nothing listens on port 1, and refusing is quick. */
const NOWHERE = "http://127.0.0.1:1/v1";

const isServerAnswering = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const listedBody: unknown = await response.json();
    const models = (listedBody as { data?: { id?: string }[] }).data ?? [];
    return models.some((entry) => entry.id === MODEL);
  } catch {
    return false;
  }
};

const isReachable = await isServerAnswering();

describeContract("openai", (scenario) => {
  if (!isReachable) return null;
  switch (scenario) {
    case "ready":
      return makeOpenAiProvider({ model: MODEL, baseUrl: BASE_URL });
    case "unavailable":
      return makeOpenAiProvider({ model: MODEL, baseUrl: NOWHERE });
    case "needs-download":
      // This backend has no such branch: the weights are the server's, and
      // nothing this side can fetch them.
      return null;
    case "tiny-window":
      // The window here is a budget the caller declares, not one the server
      // loaded — no OpenAI-compatible server takes one — so a narrow one is
      // staged by declaring it and letting the counts cross it.
      return makeOpenAiProvider({
        model: MODEL,
        baseUrl: BASE_URL,
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

const readSentHeaders = (
  init: RequestInit | undefined,
): Record<string, string> =>
  (init?.headers as Record<string, string> | undefined) ?? {};

type Respond = (init: RequestInit | undefined) => Response;

/** A server made of strings: each call answers from the first matching rule. */
const makeServer =
  (routes: Record<string, Respond>): NonNullable<OpenAiConfig["fetch"]> =>
  (input, init) => {
    const url = toUrl(input);
    for (const [path, respond] of Object.entries(routes)) {
      if (url.includes(path)) return Promise.resolve(respond(init));
    }
    return Promise.reject(new Error(`nothing routed for ${url}`));
  };

const makeJsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeModelsResponse = (...ids: string[]): Response =>
  makeJsonResponse({ object: "list", data: ids.map((id) => ({ id })) });

/**
 * Frames as the wire carries them, blank line and all, ending in `[DONE]`. The
 * leading `:` line is a proxy keep-alive — legal SSE, and not a frame.
 */
const makeSseResponse = (...frames: unknown[]): Response =>
  new Response(
    `: keep-alive\n\n${frames
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const makeDeltaFrame = (content: string): unknown => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

const makeFinishFrame = (finishReason: string): unknown => ({
  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
});

/** The counts arrive alone, after the last choice, which is where `include_usage` puts them. */
const makeUsageFrame = (
  promptTokens: number,
  answerTokens: number,
): unknown => ({
  choices: [],
  usage: {
    prompt_tokens: promptTokens,
    completion_tokens: answerTokens,
    total_tokens: promptTokens + answerTokens,
  },
});

/**
 * Both shapes the dialect has, chosen the way the server chooses: `stream:
 * true` is SSE ending on the counts, `stream: false` is one object. A stub that
 * answered the same either way would hide which of `generateStream` and
 * `generateWhole` the lifecycle took.
 */
const makeChatResponse =
  (...deltas: string[]) =>
  (init: RequestInit | undefined): Response => {
    const answer = deltas.join("");
    if (readSentBody(init).stream !== true) {
      return makeJsonResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: deltas.length,
          total_tokens: 30 + deltas.length,
        },
      });
    }
    return makeSseResponse(
      ...deltas.map((content) => makeDeltaFrame(content)),
      makeFinishFrame("stop"),
      makeUsageFrame(30, deltas.length),
    );
  };

/**
 * A round that ends in a call, fragmented the way OpenAI fragments one: the id
 * and the name in the first frame, the arguments as pieces of a JSON string
 * after it. Ollama sends the whole call in one frame, so this shape is
 * reachable from a stub and from nowhere else in this repository.
 */
const makeToolCallResponse = (
  name: string,
  argumentPieces: readonly string[],
  callId: string | null = "call_abc",
): Response =>
  makeSseResponse(
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                index: 0,
                ...(callId === null ? {} : { id: callId }),
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    ...argumentPieces.map((piece) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: piece } }],
          },
          finish_reason: null,
        },
      ],
    })),
    makeFinishFrame("tool_calls"),
    makeUsageFrame(40, 12),
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

const makeStubbedProvider = (
  routes: Record<string, Respond>,
  config: Partial<OpenAiConfig> = {},
) =>
  makeOpenAiProvider({
    model: MODEL,
    baseUrl: BASE_URL,
    ...config,
    fetch: makeServer(routes),
  });

/** A server whose chat answers come from a script, one per round, in order. */
const makeScriptedProvider = (
  rounds: readonly Respond[],
  sentBodies: Record<string, unknown>[],
  config: Partial<OpenAiConfig> = {},
) =>
  makeOpenAiProvider({
    model: MODEL,
    baseUrl: BASE_URL,
    ...config,
    fetch: (input, init) => {
      if (toUrl(input).includes("/models"))
        return Promise.resolve(makeModelsResponse(MODEL));
      sentBodies.push(readSentBody(init));
      const respond =
        rounds[sentBodies.length - 1] ?? rounds[rounds.length - 1];
      if (respond === undefined) throw new Error("no rounds scripted");
      return Promise.resolve(respond(init));
    },
  });

/**
 * Reader loop, not `new Response(...)`: these deltas are strings, and a
 * `Response` body wants bytes.
 */
const drain = async (stream: ReadableStream<string>): Promise<string> => {
  const reader = stream.getReader();
  const parts: string[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return parts.join("");
    parts.push(chunk.value);
  }
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

describe("openai against a server made of strings", () => {
  test("nothing listening is unavailable, not a failed request", async () => {
    const provider = makeOpenAiProvider({ model: MODEL, baseUrl: NOWHERE });
    const access = await provider.access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("unsupported");
  });

  test("a refused key is unavailable, and says which half is wrong", async () => {
    const provider = makeStubbedProvider({
      "/models": () =>
        makeJsonResponse({ error: { message: "Incorrect API key" } }, 401),
    });
    const access = await provider.access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    // Not `unsupported`: there is a server, and no retry of the same request
    // will get past it.
    expect(access.reason.kind).toBe("not-allowed");
  });

  test("a listing that names other models does not name this one", async () => {
    const provider = makeStubbedProvider({
      "/models": () => makeModelsResponse("something-else"),
    });
    const access = await provider.access();
    expect(access.kind).toBe("unavailable");
    if (access.kind !== "unavailable") return;
    expect(access.reason.kind).toBe("unsupported-config");
  });

  test("a server that withholds the listing is still ready", async () => {
    const provider = makeStubbedProvider({
      "/models": () => makeJsonResponse({ error: "not found" }, 404),
      "/chat/completions": makeChatResponse("ok"),
    });
    // The endpoint is optional in practice, and only the chat call can prove a
    // model — so its absence is not evidence against one.
    expect((await provider.access()).kind).toBe("ready");
  });

  test("a server that lists nothing is still ready", async () => {
    const provider = makeStubbedProvider({
      "/models": () => makeModelsResponse(),
      "/chat/completions": makeChatResponse("ok"),
    });
    expect((await provider.access()).kind).toBe("ready");
  });

  test("no key means no header, and a key means a bearer one", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const record: Respond = (init) => {
      seenHeaders.push(readSentHeaders(init));
      return makeModelsResponse(MODEL);
    };
    await makeStubbedProvider({ "/models": record }).access();
    await makeStubbedProvider(
      { "/models": record },
      { apiKey: "sk-test" },
    ).access();

    expect(seenHeaders[0]?.authorization).toBeUndefined();
    expect(seenHeaders[1]?.authorization).toBe("Bearer sk-test");
  });

  test("trailing slashes on the base url are not doubled into the path", async () => {
    const seenUrls: string[] = [];
    const askWith = async (baseUrl: string) => {
      await makeOpenAiProvider({
        model: MODEL,
        baseUrl,
        fetch: (input) => {
          seenUrls.push(toUrl(input));
          return Promise.resolve(makeModelsResponse(MODEL));
        },
      }).access();
    };

    await askWith("http://example.test/v1/");
    // A run of them, because trimming used to be `/\/+$/` — a polynomial
    // backtrack on a string a consumer may well have built from user input.
    await askWith(`http://example.test/v1${"/".repeat(5_000)}`);
    await askWith("http://example.test/v1");

    expect(seenUrls).toEqual([
      "http://example.test/v1/models",
      "http://example.test/v1/models",
      "http://example.test/v1/models",
    ]);
  });

  test("the answer arrives in frames, and keep-alives are not frames", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        "/models": () => makeModelsResponse(MODEL),
        "/chat/completions": makeChatResponse("one ", "two ", "three"),
      }),
    );
    const streamResult = await session.promptStream("count");
    if (!streamResult.ok) throw new Error("expected a stream");
    const reader = streamResult.value.getReader();
    const deltas: string[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      deltas.push(chunk.value);
    }
    // Three, not one: the `: keep-alive` line and `[DONE]` are neither content
    // nor a parse failure.
    expect(deltas).toEqual(["one ", "two ", "three"]);
    session.close();
  });

  test("the whole conversation goes out, system first and this turn last", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeOpenAiProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      fetch: (input, init) => {
        if (toUrl(input).includes("/models"))
          return Promise.resolve(makeModelsResponse(MODEL));
        sentBodies.push(readSentBody(init));
        return Promise.resolve(makeChatResponse("ok")(init));
      },
    });

    const access = await provider.access();
    if (access.kind !== "ready") throw new Error("expected ready");
    const sessionResult = await access.open({ system: "Be terse." });
    if (!sessionResult.ok) throw new Error("open refused");
    const session = sessionResult.value;
    await session.prompt("first");
    await session.prompt("second");

    expect(sentBodies[1]?.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);
    session.close();
  });

  test("a schema travels as a json_schema response format", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [makeChatResponse('{"city":"Paris"}')],
      sentBodies,
    );
    const session = await mustOpenSession(provider);
    await session.prompt("Name the capital of France.", {
      schema: CONTRACT_SCHEMA,
    });
    expect(sentBodies[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: CONTRACT_SCHEMA },
    });
    session.close();
  });

  test("the counts are asked for on a stream and not on a whole answer", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider([makeChatResponse("ok")], sentBodies);
    const session = await mustOpenSession(provider);
    await session.prompt("whole");
    const streamResult = await session.promptStream("streamed");
    if (streamResult.ok) await drain(streamResult.value);

    // `stream_options` alongside `stream: false` is a 400 on OpenAI itself.
    expect(sentBodies[0]?.stream).toBe(false);
    expect(sentBodies[0]?.stream_options).toBeUndefined();
    expect(sentBodies[1]?.stream_options).toEqual({ include_usage: true });
    session.close();
  });

  test("without a declared window there is no meter, only an answer", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        "/models": () => makeModelsResponse(MODEL),
        "/chat/completions": makeChatResponse("ok"),
      }),
    );
    await session.prompt("first");
    // No OpenAI-compatible server reports the window it loaded, and inventing
    // a denominator would make the meter a guess with a number on it.
    expect(session.usage().kind).toBe("unknown");
    session.close();
  });

  test("the counts are what the window holds, not a running sum", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider(
        {
          "/models": () => makeModelsResponse(MODEL),
          "/chat/completions": makeChatResponse("a", "b"),
        },
        { contextWindow: 4096 },
      ),
    );
    await session.prompt("first");
    const firstUsage = session.usage();
    await session.prompt("second");
    // Both turns report the same counts, and `prompt_tokens` already holds the
    // history — so the meter repeats rather than doubling.
    expect(firstUsage).toEqual(session.usage());
    if (firstUsage.kind === "bounded") expect(firstUsage.used).toBe(32);
    session.close();
  });

  test("a turn the server stopped at its own window is an overflow", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider({
        "/models": () => makeModelsResponse(MODEL),
        "/chat/completions": () =>
          makeSseResponse(
            makeDeltaFrame("one, two"),
            makeFinishFrame("length"),
            makeUsageFrame(24, 8),
          ),
      }),
    );
    let fired = 0;
    session.oncontextoverflow = () => (fired += 1);
    // No window was declared, so nothing counted crosses a line: `length` is
    // the only thing that says the turn ran out, and `max_tokens` is never
    // sent, so it can mean nothing else.
    const streamResult = await session.promptStream("first");
    if (streamResult.ok) await drain(streamResult.value);
    expect(fired).toBe(1);
    session.close();
  });

  test("a declared window spent is an overflow the server never mentioned", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider(
        {
          "/models": () => makeModelsResponse(MODEL),
          "/chat/completions": makeChatResponse("a", "b"),
        },
        { contextWindow: 32 },
      ),
    );
    let fired = 0;
    session.oncontextoverflow = () => (fired += 1);
    await session.prompt("first");
    // 30 + 2 reaches the 32 that was declared, and the server said `stop`.
    expect(fired).toBe(1);
    session.close();
  });

  test("a turn that ended on its own, inside the window, is not", async () => {
    const session = await mustOpenSession(
      makeStubbedProvider(
        {
          "/models": () => makeModelsResponse(MODEL),
          "/chat/completions": makeChatResponse("a", "b"),
        },
        { contextWindow: 4096 },
      ),
    );
    let fired = 0;
    session.oncontextoverflow = () => (fired += 1);
    await session.prompt("first");
    expect(fired).toBe(0);
    session.close();
  });

  test("a call fragmented across frames is one call when the round ends", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    let seenArguments: Record<string, unknown> | null = null;
    const provider = makeScriptedProvider(
      [
        // The shape OpenAI streams, and the reason the pieces carry an index:
        // neither half is JSON on its own.
        () => makeToolCallResponse("lookupColour", ['{"item":', '"kettle"}']),
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
    // The second round carries the call as the model's own turn and the answer
    // under the `tool` role, tied to it by id rather than by name.
    const secondMessages = (sentBodies[1] as { messages: unknown[] }).messages;
    expect(secondMessages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "lookupColour",
              arguments: '{"item":"kettle"}',
            },
          },
        ],
      },
      { role: "tool", content: "teal", tool_call_id: "call_abc" },
    ]);
    session.close();
  });

  test("a call with no id from the server still gets an answer tied to it", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [
        () => makeToolCallResponse("lookupColour", ['{"item":"kettle"}'], null),
        makeChatResponse("teal"),
      ],
      sentBodies,
    );
    const session = await mustOpenWithTool(
      provider,
      makeLookupTool(() => "teal"),
    );

    await session.prompt("What colour is the kettle?");
    const secondMessages = (sentBodies[1] as { messages: unknown[] }).messages;
    expect(secondMessages.at(-1)).toEqual({
      role: "tool",
      content: "teal",
      tool_call_id: "call_0",
    });
    session.close();
  });

  test("a name the model made up is answered by name, not by failing the turn", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [
        () => makeToolCallResponse("openSafe", ['{"code":"1234"}']),
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
      tool_call_id: "call_abc",
    });
    session.close();
  });

  test("a model that keeps calling is stopped with a reason", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const provider = makeScriptedProvider(
      [() => makeToolCallResponse("lookupColour", ['{"item":"kettle"}'])],
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

  test("the server's own words survive both error shapes", async () => {
    const nested = await mustOpenSession(
      makeStubbedProvider({
        "/models": () => makeModelsResponse(MODEL),
        "/chat/completions": () =>
          makeJsonResponse({ error: { message: "model is required" } }, 400),
      }),
    );
    const nestedResult = await nested.prompt("hello");
    expect(nestedResult.ok).toBe(false);
    if (!nestedResult.ok) {
      // 400 is this side reading badly; the detail is what the server said.
      expect(nestedResult.error.kind).toBe("invalid-input");
      if (nestedResult.error.kind === "invalid-input")
        expect(nestedResult.error.detail).toBe("model is required");
    }
    nested.close();

    const plain = await mustOpenSession(
      makeStubbedProvider({
        "/models": () => makeModelsResponse(MODEL),
        "/chat/completions": () =>
          makeJsonResponse({ error: "context length exceeded" }, 500),
      }),
    );
    const plainResult = await plain.prompt("hello");
    expect(plainResult.ok).toBe(false);
    if (!plainResult.ok) {
      expect(plainResult.error.kind).toBe("failed");
      if (plainResult.error.kind === "failed")
        expect(plainResult.error.detail).toBe("context length exceeded");
    }
    plain.close();
  });
});
