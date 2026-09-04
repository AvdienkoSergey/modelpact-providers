/**
 * The transports that cost a consumer nothing but this package: `fetch` and
 * JSON for the daemon, a global for the browser's own model, no runtime
 * dependency behind either. Import one and a bundler drops the other.
 *
 * The WebGPU backend is `modelpact-providers/webgpu` instead, because it
 * carries `@mlc-ai/web-llm` — a separate entry for a separate dependency, the
 * way `modelpact/testing` is separate for `vitest`.
 */

export { makeOllamaProvider, type OllamaConfig } from "./ollama.js";
export { makePromptApiProvider } from "./prompt-api.js";
