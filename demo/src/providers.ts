/**
 * The app's list of backends, and every one of them is this package.
 *
 * Five entries over four transports: a daemon over HTTP, that same daemon in
 * the OpenAI dialect, the dialect again with a window declared narrow enough
 * to overflow, the model inside Chrome, and a model in the tab. There is no
 * mock here on purpose. The engine's demo has one, and it belongs there: this
 * repository is about what happens when there is something on the other end,
 * and a picker where half the entries have nothing behind them argues the
 * opposite.
 *
 * The price, stated plainly: on a machine with no daemon, no Gemini Nano and
 * no GPU, every entry answers `unavailable`. That is a true answer and a dull
 * page, and it is the trade this demo makes to be about transports.
 *
 * Where each import comes from is the other half of the point. `modelpact` is
 * the contract, installed from npm like anyone else's; the backends are this
 * package. Same session, same failures, same meter on either side of that line.
 */

import { defineProviders } from "modelpact";
import {
  makeOllamaProvider,
  makeOpenAiProvider,
  makePromptApiProvider,
} from "modelpact-providers";
import { makeWebGpuProvider } from "modelpact-providers/webgpu";

/** One daemon, and two of the entries below reach it through different doors. */
const LOCAL_MODEL = "granite4:350m";
const LOCAL_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Where the `openai` entry points, and it is the dev server that decides.
 *
 * Export `OPENAI_API_KEY` before `npm run demo` and `vite.config.ts` proxies
 * `/openai` to `api.openai.com`, attaching the key in Node where the page
 * cannot see it. Without one there is no proxy and the entry stays on the
 * daemon, which is what keeps this repository's default a demo that costs
 * nothing to run.
 *
 * The key never appears here, and could not: this file is bundled and served.
 */
const HOSTED = import.meta.env.VITE_OPENAI_HOSTED;
const HOSTED_MODEL = import.meta.env.VITE_OPENAI_MODEL;

const OPENAI_CONFIG = HOSTED
  ? { model: HOSTED_MODEL, baseUrl: "/openai/v1" }
  : { model: LOCAL_MODEL, baseUrl: LOCAL_OPENAI_BASE_URL };

export const PROVIDERS = defineProviders({
  // A daemon on this machine, over `fetch` and JSON. Absent one, `access`
  // answers `unavailable` and the chip says so — no throw, no hang.
  ollama: makeOllamaProvider({ model: LOCAL_MODEL }),
  // The same daemon, the same model, `/v1/chat/completions` instead of
  // `/api/chat`. That is the entry: `baseUrl` moves it, `apiKey` is optional,
  // and a page needs no secret to show it. Put the two side by side in the
  // network panel and the only difference is the URL — and with a key exported,
  // that URL is the only thing that changes to reach a hosted model instead.
  openai: makeOpenAiProvider(OPENAI_CONFIG),
  // The window here is a budget the caller declares, not one the server loaded
  // — no server in this dialect takes one — so a narrow one is staged by
  // declaring it and letting the counts cross it on the first turn. It is what
  // a mock used to be here for, done by a real transport instead.
  //
  // Pinned to the daemon whatever the entry above does: overflowing a window
  // takes turns, and turns on a hosted model are billed.
  "openai-narrow": makeOpenAiProvider({
    model: LOCAL_MODEL,
    baseUrl: LOCAL_OPENAI_BASE_URL,
    contextWindow: 64,
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
    case "ollama":
      return "Ollama · granite4:350m";
    case "openai":
      // The label is the only place a person can tell which server is behind
      // this entry without opening the network panel.
      return HOSTED
        ? `OpenAI · ${HOSTED_MODEL}`
        : "OpenAI dialect · 127.0.0.1/v1";
    case "openai-narrow":
      return "OpenAI dialect · narrow window";
    case "prompt-api":
      return "Chrome · built-in model";
    case "webgpu":
      return "WebGPU · SmolLM2-360M";
  }
}
