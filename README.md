# modelpact-providers

[![npm](https://img.shields.io/npm/v/modelpact-providers)](https://www.npmjs.com/package/modelpact-providers)
[![ci](https://github.com/AvdienkoSergey/modelpact-providers/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/AvdienkoSergey/modelpact-providers/actions/workflows/ci.yml)
![node: ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933)
[![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**The transports for [modelpact](https://github.com/AvdienkoSergey/modelpact):
a daemon on your machine, any OpenAI-compatible server, the model inside
Chrome, and a model in the tab itself. Four backends, one contract, and that
contract's suite green on each.**

The engine holds the contract, the lifecycle and one backend with nothing
behind it. This package holds the ones with something behind them. They are
apart because they change for different reasons: a daemon's JSON, a hosted
API's dialect, a browser's origin trial and a WebGPU runtime each move on their
own clock, and none of them should move the contract.

## Install

```sh
npm install modelpact-providers modelpact
```

`modelpact` is a peer dependency: this package is written against its contract
and carries no copy of it.

## The four

| Provider                | Reaches                                   | Wants                                              | Import from                  |
| ----------------------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------- |
| `makeOllamaProvider`    | a daemon over HTTP, usually local         | Ollama on `127.0.0.1:11434`                        | `modelpact-providers`        |
| `makeOpenAiProvider`    | anything speaking the OpenAI HTTP dialect | a `baseUrl`; a key only where the server wants one | `modelpact-providers`        |
| `makePromptApiProvider` | Chrome's built-in Gemini Nano             | Chrome, and the weights downloaded once            | `modelpact-providers`        |
| `makeWebGpuProvider`    | a model in the tab, on WebGPU             | `@mlc-ai/web-llm`, and a GPU                       | `modelpact-providers/webgpu` |

```ts
import { makeOllamaProvider } from "modelpact-providers";

const access = await makeOllamaProvider({ model: "granite4:350m" }).access();
if (access.kind !== "ready") return;
const opened = await access.open({ system: "Answer in one sentence." });
```

Everything after the provider line is the contract's, and identical across the
four — see [modelpact's README](https://github.com/AvdienkoSergey/modelpact#readme)
for what a session promises.

## Two entries, and the reason

`modelpact-providers` is the three that cost a consumer nothing: `fetch` and
JSON for the daemon and for the OpenAI dialect, a global for the browser's own
model, no runtime dependency behind any of them.
`modelpact-providers/webgpu` is the fourth, because it carries
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

**An OpenAI-compatible server.** A dialect rather than a company:
`https://api.openai.com/v1` is the default and one instance of it, and the same
two endpoints answer on vLLM, llama.cpp, LM Studio, OpenRouter, Groq and
Ollama's own `/v1`. So `baseUrl` is the whole difference between them and
`apiKey` is optional — a model on your machine wants no key, and a type that
demanded one would be describing a service instead of a protocol. It is also
the only backend here that never answers `needs-download`: the weights are the
server's problem, and there is nothing this side could fetch.

Two things the wire does that the daemon next door does not, and both are
handled rather than assumed: a tool call arrives fragmented across frames,
keyed by `index`, with its arguments as a JSON string rather than an object;
and the counts arrive in a frame of their own after the last one carrying text,
which is what `stream_options: { include_usage: true }` asks for.

`contextWindow` is optional, and absent it `usage()` answers `unknown`. No
server in this dialect reports the window it loaded a model with, so a number
there is your declaration, not a discovery — and being a declaration is what
makes it a budget too: a transcript past it is an overflow, told by the counts
rather than by the server.

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

All four accept `ModelRequest.tools`, and each executes them the way its
transport can.

| Provider   | How a call happens                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Ollama     | native `tool_calls`, answered under the `tool` role, in rounds bounded by `maxToolRounds`           |
| OpenAI     | the same, tied by `tool_call_id` rather than by name, so two calls to one tool in a turn stay apart |
| Prompt API | handed to `create()`, and the browser calls `execute` itself                                        |
| WebGPU     | not yet: the request is refused at `access`, which is the contract's answer for a backend without   |

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

[`demo/tsconfig.json`](demo/tsconfig.json) is the fourth, and the only one that
is an application rather than a check: `types: ["vite/client"]`, no ambient
Prompt API and no `@mlc-ai/web-llm`, which is the same claim made by code that
actually imports and calls the things. It is where the demo caught the
`MLCEngineInterface` leak the first time.

## Scripts

| Script                  | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `npm run typecheck`     | both source configs, and the specs                     |
| `npm run lint`          | ESLint, type-aware                                     |
| `npm run format:check`  | Prettier, check only                                   |
| `npm test`              | Vitest; the Ollama contract suite skips with no daemon |
| `npm run test:e2e`      | Playwright; starts the demo itself                     |
| `npm run check:surface` | builds, then reads the declarations from outside       |
| `npm run demo`          | the demo on a dev server                               |
| `npm run demo:check`    | the demo's own tsconfig — a consumer with no `@types`  |
| `npm run build`         | `dist/` — JS, declarations, maps                       |

The Ollama suite wants a daemon on `127.0.0.1:11434` holding `granite4:350m`,
and the OpenAI suite wants an OpenAI-compatible server — that same daemon's
`/v1`, by default, which is a genuine third-party implementation of the dialect
and already there. Without one, each skips loudly rather than passing quietly.

## The demo

[`demo/`](demo) is a chat with all four transports behind one picker, and
nothing else behind it: no mock, because the engine's demo has one and this
repository is about what happens when there is something on the other end. On a
machine with no daemon, no Gemini Nano and no GPU, every entry therefore answers
`unavailable` — honest, and dull. A daemon on `127.0.0.1:11434` holding
`granite4:350m` is what makes three of the five entries answer.

```sh
npm install
npm run demo
```

It takes `modelpact` from npm, at the version a stranger would get, and this
package from `file:..` through its own `exports` — so what runs in the page is
`dist/`, never `src/`. Both land on one copy of the engine because `demo` is a
workspace of this repository; the reason that matters, and what breaks without
it, is in [`demo/README.md`](demo/README.md).

It also type-checks itself with `types: ["vite/client"]` and nothing else,
which makes it the second half of the surface guard above: a declaration that
needs an ambient global fails in an app that never installed one.

## The browser suite

[`e2e/demo-e2e.spec.ts`](e2e/demo-e2e.spec.ts) drives the demo in Chromium.

```sh
npx playwright install chromium   # once
npm run test:e2e                  # the demo server starts itself
```

Twelve specs. The vitest suites next to each backend check its logic against
the contract from node; these check what node cannot see:

- a page is not node. `fetch` held on its own throws `Illegal invocation` in
  one and works in the other, and that bug is invisible to any vitest run;
- `LanguageModel` and `navigator.gpu` exist in a browser and nowhere else, so
  the Prompt API and WebGPU backends have their first real `availability()`
  call here;
- the emitted `.d.ts` files, a bundler, and React sit between the app and the
  backend, which no unit test reproduces.

Six of them want a daemon and skip without one — everything that needs a
session to actually open, which since the mock left the picker means every
promise the contract makes about a session. That is the cost of a demo about
transports, and it is paid where it belongs: CI installs a daemon for this job.

The other six assert a branch rather than a machine, and are green anywhere. A
runner with no Gemini Nano and no GPU still has `unavailable` to land on, and
landing on it is the claim. Both HTTP transports get their refusal answer on
every machine too, including a laptop with Ollama running, because that spec
refuses the connection itself rather than waiting for a machine without one.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) has three jobs, and each
can go red on its own:

| Job      | Runs                                                                     |
| -------- | ------------------------------------------------------------------------ |
| `check`  | typecheck, lint, format, vitest, `check:surface` — one install, no model |
| `ollama` | the same vitest suites with a daemon answering                           |
| `e2e`    | Playwright against the demo, with a daemon, in Chromium                  |

**Adding the browser suite to a fork or another pipeline** is four steps:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version-file: .nvmrc
    cache: npm
# `demo` is a workspace, so this installs it too — and puts one copy of
# `modelpact` where both it and this package find it.
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npm run test:e2e
```

`npm run test:e2e` starts the demo itself, and the demo's `predev` builds
`dist/` first, so there is no build step to add and no server to start.

Two options on top of that:

- **A daemon**, which is not really optional any more: half the specs skip
  without one. Install Ollama, `ollama serve`, `ollama pull granite4:350m`, and
  cache `~/.ollama/models` — the `e2e` job does exactly this, restore-only,
  sharing the key the `ollama` job saves. Without it the suite still passes,
  on the six specs that assert a branch rather than a session.
- **The report on failure**, which is `actions/upload-artifact` over
  `playwright-report/`. Playwright writes it whether or not anyone collects it.

Nothing here needs a GPU or a Chrome with Gemini Nano. Those two backends
answer `unavailable` on a plain runner, and the specs assert the branch.

## Releases

Versions come from [conventional commits](https://www.conventionalcommits.org)
by way of release-please, and are published to npm from CI by trusted
publishing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
