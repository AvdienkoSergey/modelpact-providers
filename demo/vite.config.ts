import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  // `loadEnv` and not `process.env`: this file is type-checked with
  // `types: ["vite/client"]` and no node types, deliberately, and an empty
  // prefix makes it read the shell's own variables as well as any `.env`.
  const env = loadEnv(mode, ".", "");
  const apiKey = env["OPENAI_API_KEY"] ?? "";
  const hostedModel = env["OPENAI_MODEL"] ?? "gpt-4o-mini";
  // `command === "serve"` and not just the key: the proxy below is a dev-server
  // feature and does not exist in a build, so a built page told it was hosted
  // would fetch `/openai/v1` from whatever serves the static files and get a
  // 404. Hosted mode is the dev server's, and says so here rather than failing
  // in someone's `vite preview`.
  const isHosted = apiKey !== "" && command === "serve";

  return {
    plugins: [react()],
    resolve: {
      // Insurance, and cheap. Two packages here reach for `modelpact`: this
      // app, which has it from npm, and `modelpact-providers`, which is
      // `file:..` and therefore resolves from the repo root. The workspace
      // hoists them onto one copy, and this keeps them there if an install ever
      // nests a second — because `AiError` from one copy is not
      // `instanceof AiError` from the other, and an aborted turn would come
      // back as `unknown`.
      dedupe: ["modelpact"],
    },
    // Two values reach the page, and the key is not one of them. It is read
    // here, in a Node process, and attached to the proxied request below —
    // never bundled, never in a `VITE_` variable, never in the page's reach. A
    // key in a bundle is a key handed to everyone who loads it.
    define: {
      "import.meta.env.VITE_OPENAI_HOSTED": JSON.stringify(isHosted),
      "import.meta.env.VITE_OPENAI_MODEL": JSON.stringify(hostedModel),
    },
    // No proxy without a key: the `openai` entry then stays on the daemon, and
    // this repository's default remains a demo that costs nothing to run.
    ...(isHosted
      ? {
          server: {
            proxy: {
              "/openai": {
                target: "https://api.openai.com",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/openai/, ""),
                headers: { Authorization: `Bearer ${apiKey}` },
              },
            },
          },
        }
      : {}),
  };
  // No alias for `modelpact-providers`: it is a dependency at `file:..`,
  // resolved through its own `exports` into `dist`, which is what `npm i` hands
  // anyone else. `predev` builds it first. The price is that an edit to a
  // backend needs a rebuild to reach this page, and that is the right price:
  // the backends are developed against their contract suites, and this is the
  // shop window.
});
