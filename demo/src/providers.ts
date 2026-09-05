/**
 * The app's list of backends. One object, and its keys are the app's provider
 * names: the switch in `getProviderLabel` below stays exhaustive because of it.
 *
 * Four of them are this package — a daemon over HTTP, the same daemon in the
 * OpenAI dialect, the model inside Chrome, a model in the tab — and three are
 * the engine's mock with different settings. The mocks are here because two branches of `ModelAccess` cannot be
 * staged on demand by a real one: a window narrow enough to overflow in two
 * turns, and a download that finishes while you watch. Nothing outside this
 * file knows which is which, and that is the claim the rest of the demo exists
 * to make honest.
 *
 * Where each import comes from is the point of the file. `modelpact` is the
 * contract and the mock, installed from npm like anyone else's; the transports
 * come from this package. Same session, same failures, same meter on either
 * side of that line.
 */

import { defineProviders, makeMockProvider } from "modelpact";
import {
  makeOllamaProvider,
  makeOpenAiProvider,
  makePromptApiProvider,
} from "modelpact-providers";
import { makeWebGpuProvider } from "modelpact-providers/webgpu";

/** Long enough to watch arrive, and to reach the stop button before it ends. */
const generateReply = (input: string): readonly string[] => {
  const askedText = input.trim().replace(/\s+/g, " ").slice(0, 60);
  const sentence =
    `You asked «${askedText}». There is no model behind this: the mock streams ` +
    `a canned answer one word at a time, which is enough to show a stream, ` +
    `an abort that leaves the session open, and a window filling up.`;
  const words = sentence.match(/\S+\s*/g) ?? ["…"];
  return words;
};

const MOCK_SETTINGS = { reply: generateReply, delayMs: 45 };

export const PROVIDERS = defineProviders({
  // The control. Whatever the three below do, they do it through this session.
  mock: makeMockProvider(MOCK_SETTINGS),
  // Narrow enough that the second turn crosses the line.
  "mock-narrow": makeMockProvider({ ...MOCK_SETTINGS, contextWindow: 60 }),
  // Enough steps that the bar is something you watch rather than something
  // you miss: the mock waits `delayMs` between them.
  "mock-download": makeMockProvider({
    ...MOCK_SETTINGS,
    access: "needs-download",
    downloadSteps: [
      0, 0.06, 0.14, 0.23, 0.35, 0.44, 0.58, 0.7, 0.79, 0.88, 0.95, 1,
    ],
  }),
  // A daemon on this machine, over `fetch` and JSON. Absent one, `access`
  // answers `unavailable` and the chip says so — no throw, no hang.
  ollama: makeOllamaProvider({ model: "granite4:350m" }),
  // The OpenAI dialect, pointed at the same daemon's `/v1` rather than at
  // `api.openai.com`. That is the entry: `baseUrl` moves it, `apiKey` is
  // optional, and a page needs no secret to show it. A key in a bundle is a
  // key handed to everyone who loads the page, so the one server this demo
  // will talk to is the one on this machine.
  openai: makeOpenAiProvider({
    model: "granite4:350m",
    baseUrl: "http://127.0.0.1:11434/v1",
  }),
  // Chrome's own, which needs no configuring and no daemon. On a browser
  // without it `access` answers `unavailable`; on one with it undownloaded,
  // the weights are gigabytes, which is what the consent button exists for.
  "prompt-api": makePromptApiProvider(),
  // A model in the tab on WebGPU, from `modelpact-providers/webgpu` — a second
  // entry because it carries `@mlc-ai/web-llm`, and this app is the one place
  // that dependency is actually installed. Hundreds of megabytes into browser
  // storage, behind the same button as Chrome's.
  webgpu: makeWebGpuProvider({ model: "SmolLM2-360M-Instruct-q4f16_1-MLC" }),
});

export type ProviderName = keyof typeof PROVIDERS;

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

export function getProviderLabel(providerName: ProviderName): string {
  switch (providerName) {
    case "mock":
      return "Mock · engine";
    case "mock-narrow":
      return "Mock · narrow window";
    case "mock-download":
      return "Mock · downloads first";
    case "ollama":
      return "Ollama · granite4:350m";
    case "openai":
      return "OpenAI dialect · 127.0.0.1/v1";
    case "prompt-api":
      return "Chrome · built-in model";
    case "webgpu":
      return "WebGPU · SmolLM2-360M";
  }
}
