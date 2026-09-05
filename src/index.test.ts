/**
 * What the entry offers, pinned. A provider dropped from here is a break for
 * every consumer, and this is where it shows before their build does.
 *
 * The WebGPU backend is deliberately absent: it lives at
 * `modelpact-providers/webgpu`, and `src/webgpu.test.ts` is its suite.
 */

import { expect, test } from "vitest";

import * as entry from "./index.js";

test("the entry offers the three dependency-free transports", () => {
  expect(Object.keys(entry).sort()).toEqual([
    "makeOllamaProvider",
    "makeOpenAiProvider",
    "makePromptApiProvider",
  ]);
});
