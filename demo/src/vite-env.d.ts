/// <reference types="vite/client" />

/**
 * What the dev server tells the page about hosted OpenAI, and the whole of it.
 *
 * The key is deliberately absent and cannot be added: it is read in
 * `vite.config.ts`, which runs in Node, and attached to the proxied request
 * there. Anything named here ends up in the bundle.
 */
interface ImportMetaEnv {
  /** True when the dev server holds a key and is proxying `/openai`. */
  readonly VITE_OPENAI_HOSTED: boolean;
  /** Which model the hosted entry asks for; `OPENAI_MODEL`, or `gpt-4o-mini`. */
  readonly VITE_OPENAI_MODEL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
