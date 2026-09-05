# The demo

Six backends behind one picker: three of them this package's transports — a
daemon over HTTP, the model inside Chrome, a model in the tab on WebGPU — and
three of them the engine's mock, which is here because two branches of
`ModelAccess` cannot be staged on demand by a real backend.

```sh
npm install   # from the repo root, once: this directory is a workspace
npm run demo  # or: npm --prefix demo run dev
```

## Where the imports come from

That is the whole point of the app, and it is one file —
[`src/providers.ts`](src/providers.ts):

```ts
import { defineProviders, makeMockProvider } from "modelpact";
import { makeOllamaProvider, makePromptApiProvider } from "modelpact-providers";
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
| "The conversation outgrew…"         | `oncontextoverflow`, fired once, on the narrow-window mock                      |
| The progress line on first open     | the `needs-download` branch and its monitor                                     |
| "Download them" before a fetch      | that branch, not opened unasked                                                 |
| Reload, and it is still there       | `session.history()` out, `open({ history })` back in                            |
| A second tab staying in step        | the `storage` event, not a contract feature                                     |
| The `ollama` entry answering        | a real model, through the same session as the mocks                             |
| The `prompt-api` entry              | Chrome's own model, mapped by the same four answers                             |
| The `webgpu` entry                  | the package's second entry point, and its optional peer dependency              |
| **Read the page** ticked            | `ModelRequest.tools`: the mock tool from `modelpact/tools`, run inside the turn |
| "This backend has no tool protocol" | a refusal at `access` with `tools: true`, which is WebGPU's answer today        |

The Ollama entry wants a daemon on `127.0.0.1:11434` holding `granite4:350m`.
Without one it answers `unavailable` and the chip says so — no throw, no hang,
which is the branch the mocks cannot stage.

The Chrome entry needs no configuring. What it usually lands on is
`needs-download`, and that branch is not opened for you: Gemini Nano is
gigabytes, and a dropdown is not consent. The button is. The WebGPU entry sits
behind the same button, for a few hundred megabytes of its own.

**Read the page** hands the session one tool, `pageTitle`: the mock tool from
`modelpact/tools` with the page's title behind it. The chip says
`ready · tools` once a session has opened with it, and each transport runs it
the way it can — the mock when its name is in the message, Ollama natively,
Chrome by calling `execute` itself, and WebGPU not at all, which arrives as a
refusal rather than a silently dropped request. Each call shows in the record
as a grey line, because the record itself holds only turns.

## Where the interesting parts are

- [`src/providers.ts`](src/providers.ts) — the registry, the three imports, and
  the exhaustive switch its keys buy.
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
