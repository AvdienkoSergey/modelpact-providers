# Contributing

## Getting set up

```sh
git clone https://github.com/AvdienkoSergey/modelpact-providers
cd modelpact-providers
npm ci
npm test
```

Node 22 or newer, which is what [`.nvmrc`](.nvmrc) says and what CI installs.

`npm ci` works on any npm that ships with it. `npm install` — adding or
bumping a dependency — wants npm 11 or newer: npm 10 crashes with
`Cannot read properties of null (reading 'edgesOut')` resolving vitest 4's
tree. `npm install -g npm@latest` once, and it is behind you.

## What CI runs, and how to run it first

CI is the reviewer that has to say yes before a human looks. All of it runs
locally:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The browser suite is a job of its own, and wants a browser downloaded once:

```sh
npx playwright install chromium
npm run test:e2e
```

It starts the demo itself. One spec wants something installed — a daemon on
`127.0.0.1:11434` holding `granite4:350m`, which is what has Ollama generate
for real — and skips without it. The rest assert a branch rather than a
machine: no Gemini Nano and no GPU still land on `unavailable`, and landing on
it is the claim.

[`demo/`](demo) is a workspace, so `npm ci` installs it and there is no second
install to remember.

## Commits

[Conventional commits](https://www.conventionalcommits.org) — release-please
reads them to decide the next version and to write
[`CHANGELOG.md`](CHANGELOG.md). `feat:` is a minor, `fix:` a patch, and a `!`
after the type is a major:

```
feat: an OpenAI-compatible backend
fix: a cancelled reader no longer frees the next turn
refactor!: name the connection a connection
```

The subject is a sentence about what changed for the reader, not a label. The
body is where the reason goes.

## Pull requests

One change per pull request, against `main`. Say what a reader gets that they
did not have before, and what you measured. A behaviour change wants a test
that goes red without it.
