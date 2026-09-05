# modelpact-providers

[![npm](https://img.shields.io/npm/v/modelpact-providers)](https://www.npmjs.com/package/modelpact-providers)
[![ci](https://github.com/AvdienkoSergey/modelpact-providers/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/AvdienkoSergey/modelpact-providers/actions/workflows/ci.yml)
![node: ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933)
[![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**The transports for [modelpact](https://github.com/AvdienkoSergey/modelpact):
a daemon on your machine, the model inside Chrome, and a model in the tab
itself. Three backends, one dialect, and the contract suite green on each.**

The engine holds the contract, the lifecycle and one backend with nothing
behind it. This package holds the ones with something behind them. They are
apart because they change for different reasons: a daemon's JSON, a browser's
origin trial and a WebGPU runtime each move on their own clock, and none of
them should move the contract.

## Install

```sh
npm install modelpact-providers modelpact
```

`modelpact` is a peer dependency: this package is written against its contract
and carries no copy of it.

## The three

| Provider                | Reaches                           | Wants                                   | Import from                  |
| ----------------------- | --------------------------------- | --------------------------------------- | ---------------------------- |
| `makeOllamaProvider`    | a daemon over HTTP, usually local | Ollama on `127.0.0.1:11434`             | `modelpact-providers`        |
| `makePromptApiProvider` | Chrome's built-in Gemini Nano     | Chrome, and the weights downloaded once | `modelpact-providers`        |
| `makeWebGpuProvider`    | a model in the tab, on WebGPU     | `@mlc-ai/web-llm`, and a GPU            | `modelpact-providers/webgpu` |

```ts
import { makeOllamaProvider } from "modelpact-providers";

const access = await makeOllamaProvider({ model: "granite4:350m" }).access();
if (access.kind !== "ready") return;
const opened = await access.open({ system: "Answer in one sentence." });
```

Everything after the provider line is the contract's, and identical across the
three — see [modelpact's README](https://github.com/AvdienkoSergey/modelpact#readme)
for what a session promises.

## Two entries, and the reason

`modelpact-providers` is the two that cost a consumer nothing: `fetch` and JSON
for the daemon, a global for the browser's own model, no runtime dependency
behind either. `modelpact-providers/webgpu` is the third, because it carries
`@mlc-ai/web-llm` — an optional peer dependency, so an app on the daemon never
installs it. The split is by dependency, not by kind: the same reason
`modelpact/testing` is a separate entry for `vitest`.

## What each one is

**Ollama.** Three endpoints are the whole backend — `/api/tags` says what is
downloaded, `/api/pull` downloads, `/api/chat` generates. Shapes were read off
a running daemon, not off the docs: a chat stream is NDJSON whose last line
carries the counts, a pull line carries `completed` and `total` per layer, and
an error is an HTTP status with a body. The daemon keeps nothing between
requests, so the session's record is resent whole every turn.

**Chrome's built-in model.** The one backend that keeps the conversation
itself: `LanguageModel` is a session object and `prompt()` appends to it, so
the record travels with the session rather than in the request. It fires its
own `contextoverflow`, which is forwarded rather than re-derived, and reports
usage against a window it decides — 9 216 tokens on Chrome 152, measured.
The declarations are `@types/dom-chromium-ai`, patched under
[`patches/`](patches) because the IDL is looser than the spec: several states
the algorithm rejects at runtime are writable in the types, and a TS error at
the keyboard beats a `TypeError` in the browser.

**WebGPU.** A model in the tab through `@mlc-ai/web-llm`, and the only backend
whose download costs the user their bandwidth rather than a daemon's. It was
written before this package existed, in a directory one repository over, to
answer one question: is the published API enough to write a backend with. It
was, and it needed nothing added to the contract.

## Tools

All three accept `ModelRequest.tools`, and each executes them the way its
transport can.

| Provider   | How a call happens                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Ollama     | native `tool_calls`, answered under the `tool` role, in rounds bounded by `maxToolRounds`         |
| Prompt API | handed to `create()`, and the browser calls `execute` itself                                      |
| WebGPU     | not yet: the request is refused at `access`, which is the contract's answer for a backend without |

Chrome 152 answers `available` to `availability()` with tools and then throws
`InvalidStateError` from `create()` — measured, and it arrives as a refusal at
`open`. A loop above should expect a refusal in both places and fall back to a
schema-constrained answer.

## The guard

[`src/surface.ts`](src/surface.ts) names every published type on both sides —
the engine's and this package's — and
[`tsconfig.surface.json`](tsconfig.surface.json) compiles it with
`skipLibCheck` off and `types: []`, which is how a consumer reads a `.d.ts`. A
declaration that needs an ambient global fails there and nowhere else.

That guard has found the same bug three times, in three packages. A published
type naming `LanguageModel` broke a consumer who never installed
`@types/dom-chromium-ai`. A `WebGpuConfig.engine` typed with
`MLCEngineInterface` broke one the same way, through `@mlc-ai/web-llm`'s own
declarations, which name packages they do not depend on. Both fixes are the
same: a structural type of exactly what the backend uses, named locally, and no
third-party type in any exported signature.

Moving here found a third. `@mlc-ai/web-llm`'s `interruptGenerate()` returns a
promise, though its own published interface says it returns nothing; the
adapter called it and dropped that promise on the floor. It is marked `void`
now, deliberately, because by the time it runs the lifecycle has already
answered the caller.

Three tsconfigs, and each has one job:

| File                                             | Checks                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| [`tsconfig.json`](tsconfig.json)                 | the source. `skipLibCheck` on, because `@mlc-ai/web-llm` cannot survive it |
| [`tsconfig.patched.json`](tsconfig.patched.json) | everything but WebGPU, with `skipLibCheck` off — the patch, still applying |
| [`tsconfig.surface.json`](tsconfig.surface.json) | the emitted declarations, as a consumer receives them                      |

## Scripts

| Script                  | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `npm run typecheck`     | both source configs                                    |
| `npm run lint`          | ESLint, type-aware                                     |
| `npm run format:check`  | Prettier, check only                                   |
| `npm test`              | Vitest; the Ollama contract suite skips with no daemon |
| `npm run check:surface` | builds, then reads the declarations from outside       |
| `npm run build`         | `dist/` — JS, declarations, maps                       |

The Ollama suite wants a daemon on `127.0.0.1:11434` holding `granite4:350m`.
Without one it skips loudly rather than passing quietly.

## Releases

Versions come from [conventional commits](https://www.conventionalcommits.org)
by way of release-please, and are published to npm from CI by trusted
publishing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
