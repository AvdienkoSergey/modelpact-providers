import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Insurance, and cheap. Two packages here reach for `modelpact`: this app,
    // which has it from npm, and `modelpact-providers`, which is `file:..` and
    // therefore resolves from the repo root. The workspace hoists them onto one
    // copy, and this keeps them there if an install ever nests a second —
    // because `AiError` from one copy is not `instanceof AiError` from the
    // other, and an aborted turn would come back as `unknown`.
    dedupe: ["modelpact"],
  },
  // No alias for `modelpact-providers`: it is a dependency at `file:..`,
  // resolved through its own `exports` into `dist`, which is what `npm i` hands
  // anyone else. `predev` builds it first. The price is that an edit to a
  // backend needs a rebuild to reach this page, and that is the right price:
  // the backends are developed against their contract suites, and this is the
  // shop window.
});
