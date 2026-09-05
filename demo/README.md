# The demo

Five entries over this package's four transports: a daemon over HTTP, that
same daemon in the OpenAI dialect, the dialect again with a window declared
narrow enough to overflow, the model inside Chrome, and a model in the tab on
WebGPU.

No mock. The engine's demo has one and it belongs there; this repository is
about what happens when there is something on the other end, and a picker where
half the entries have nothing behind them argues the opposite. The price is
stated rather than hidden: **on a machine with no daemon, no Gemini Nano and no
GPU every entry answers `unavailable`**, and the page is honest and dull. A
daemon on `127.0.0.1:11434` holding `granite4:350m` is what makes three of the
five answer.

```sh
npm install   # from the repo root, once: this directory is a workspace
npm run demo  # or: npm --prefix demo run dev
```

## Where the imports come from

That is the whole point of the app, and it is one file —
[`src/providers.ts`](src/providers.ts):

```ts
import { defineProviders } from "modelpact";
import {
  makeOllamaProvider,
  makeOpenAiProvider,
  makePromptApiProvider,
} from "modelpact-providers";
import { makeWebGpuProvider } from "modelpact-providers/webgpu";
```

`modelpact` is installed from npm, at the version a stranger would get.
`modelpact-providers` is this repository at `file:..`, resolved through its own
`exports` into `dist` — the same files `npm i` would hand that stranger, and no
path into anyone's `src/`. `predev` builds it first, so an edit to a backend
reaches this page after a rebuild and not before. That is deliberate: the
backends are developed against their contract suites, and this is the shop
window.

Nothing else in the app knows which package a provider came from. The picker
changes the backend and every other line stays as it was.

> The engine still ships copies of the Ollama and Prompt API backends at
> `modelpact@2.2.x`, from before they moved here. This app takes them from this
> package on purpose — that import line is the thing being demonstrated.

## Why it is a workspace, and not its own install

Both this app and `modelpact-providers` reach for `modelpact`. Installed
separately they get one copy each, and a brand on `JsonSchema` makes `tsc` say
so — two `AiProvider` types that are structurally identical and not assignable.
At runtime it is quieter and worse: `AiError` from one copy is not
`instanceof AiError` from the other, so a stopped turn comes back as `unknown`
instead of `aborted` and the app shows the wrong notice.

`"workspaces": ["demo"]` in the root `package.json` hoists one copy for both,
which is also what a flat `npm i modelpact modelpact-providers` gives anyone
else. `resolve.dedupe` in [`vite.config.ts`](vite.config.ts) holds that line if
an install ever nests a second copy anyway.

## What it is here to show

| On screen                           | In the contract                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| The picker, and nothing else moving | one `AiProvider` per entry; `defineProviders` keeps the keys literal            |
| Words arriving one at a time        | `promptStream` and a reader loop                                                |
| **Stop** halfway through            | `signal`, and a session that is still open afterwards                           |
| The interrupted answer vanishing    | only completed turns reach `session.history()`                                  |
| The meter beside the picker         | `session.usage()`                                                               |
| The chip beside it                  | `AccessKind`, one line per branch of `ModelAccess`                              |
| "The conversation outgrew…"         | `oncontextoverflow`, fired once, on the `openai-narrow` entry                   |
| "Download them" before a fetch      | the `needs-download` branch, not opened unasked                                 |
| Reload, and it is still there       | `session.history()` out, `open({ history })` back in                            |
| A second tab staying in step        | the `storage` event, not a contract feature                                     |
| The `ollama` entry answering        | a daemon's own dialect, `/api/chat`                                             |
| The `openai` entry answering        | that same daemon, reached by moving `baseUrl` and nothing else                  |
| The `prompt-api` entry              | Chrome's own model, mapped by the same four answers                             |
| The `webgpu` entry                  | the package's second entry point, and its optional peer dependency              |
| **Read the page** ticked            | `ModelRequest.tools`: the mock tool from `modelpact/tools`, run inside the turn |
| "This backend has no tool protocol" | a refusal at `access` with `tools: true`, which is WebGPU's answer today        |

Without a daemon the first three entries answer `unavailable` and the chip says
so — no throw, no hang, which is a branch worth seeing in its own right.

The OpenAI entry is that same daemon through `/v1`, and it is here to show what
`baseUrl` buys: the dialect that reaches `api.openai.com` also reaches a server
on this machine, and `apiKey` is left unset because a local one wants none.
That is not a shortcut around a key — it is the reason the config has a
`baseUrl` at all. A key belongs on a server you run, never in a page anyone can
load. Put it beside the `ollama` entry in the network panel and the only
difference is the URL.

**OpenAI dialect · narrow window** is the same again with `contextWindow: 64`.
No server in this dialect reports the window it loaded a model with, so that
number is a declaration rather than a discovery — and being a declaration is
what makes it a budget: one ordinary turn measures about 95 tokens all in, so
the first one crosses the line and the notice appears. This entry is what a
mock used to be here for, done by a real transport instead.

The Chrome entry needs no configuring. What it usually lands on is
`needs-download`, and that branch is not opened for you: Gemini Nano is
gigabytes, and a dropdown is not consent. The button is. The WebGPU entry sits
behind the same button, for a few hundred megabytes of its own.

**Read the page** hands the session one tool, `pageTitle`: the mock tool from
`modelpact/tools` with the page's title behind it. The chip says
`ready · tools` once a session has opened with it, and each transport runs it
the way it can — Ollama and the OpenAI dialect natively, Chrome by calling
`execute` itself, and WebGPU not at all, which arrives as a refusal rather than
a silently dropped request. Each call shows in the record as a grey line,
because the record itself holds only turns.

## Where the interesting parts are

- [`src/providers.ts`](src/providers.ts) — the registry, where each backend is
  imported from, and the exhaustive switch its keys buy.
- [`src/useChat.ts`](src/useChat.ts) — every call into the contract. A session
  is a resource, so it lives in a ref and is closed by the effect that opened
  it.
- [`src/storage.ts`](src/storage.ts) — the part the contract deliberately does
  not do. The record it hands out is plain `{ role, content }` objects, so
  storing it is `JSON.stringify` and nothing more.
- [`src/App.tsx`](src/App.tsx) — three `Record`s keyed by `AccessKind`,
  `FailureKind` and `UsageKind`. The middle one is the reason those aliases
  exist: a UI that owes a sentence to every refusal the vocabulary has, and a
  build that stops here when a new one is added rather than showing someone a
  tag.

## Type-checking

This directory is outside the repo's eslint and outside its tsconfig: it has
its own, with `types: ["vite/client"]` and nothing else. That is not laziness —
it is the second half of the guard in [`src/surface.ts`](../src/surface.ts). A
published declaration that quietly needs `@types/dom-chromium-ai` or
`@mlc-ai/web-llm`'s ambient types fails here, in an app that never installed
them.

```sh
npm run demo:check   # from the repo root
```

## Tests

[`e2e/demo-e2e.spec.ts`](../e2e/demo-e2e.spec.ts) drives this app in Chromium.
See [the repo README](../README.md#the-browser-suite).
