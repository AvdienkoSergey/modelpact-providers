# modelpact-providers

Language-model backends written against the modelpact contract — one transport per runtime, each green on the contract suite

## Install

```sh
npm install modelpact-providers modelpact
```

`modelpact` is a peer dependency: this package is built against its contract
and does not carry a copy of it.

## Scripts

| Script                 | What it does                     |
| ---------------------- | -------------------------------- |
| `npm run typecheck`    | `tsc --noEmit` over `src`        |
| `npm run lint`         | ESLint, type-aware               |
| `npm run format:check` | Prettier, check only             |
| `npm test`             | Vitest, once                     |
| `npm run test:watch`   | Vitest, watching                 |
| `npm run build`        | `dist/` — JS, declarations, maps |

## Releases

Versions come from [conventional commits](https://www.conventionalcommits.org)
by way of release-please, and are published to npm from CI by trusted
publishing. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
