/**
 * Both sets of declarations, read the way a consumer receives them.
 *
 * `tsconfig.surface.json` compiles this file and nothing else with
 * `skipLibCheck` off and `types` empty — no ambient `@types` handed over for
 * free. Two things fail here and nowhere else:
 *
 * - a name in `modelpact`'s published `.d.ts` that a consumer does not have.
 *   This package is the engine's first outside consumer, so this is where that
 *   shows;
 * - a name in *our* emitted `.d.ts` that a consumer does not have — the
 *   `LanguageModel` globals the Prompt API backend uses in its bodies, or
 *   anything from `@mlc-ai/web-llm`, which ships declarations naming packages
 *   it does not depend on. Hence the imports from `../dist`, which is why
 *   `check:surface` builds first.
 */

import {
  contextUsage,
  createProvider,
  err,
  failureFromError,
  findTool,
  fraction,
  jsonSchema,
  ndjsonLines,
  ok,
  runTool,
  toolThrewFailure,
  tokens,
  AiError,
  type AiFailure,
  type AiMessage,
  type AiProvider,
  type AiRole,
  type Availability,
  type ConnectOptions,
  type ContextUsage,
  type FailureKind,
  type Fraction,
  type GenerateRequest,
  type JsonSchema,
  type Modality,
  type ModalityExpectation,
  type ModelBackend,
  type ModelConnection,
  type ModelRequest,
  type ProviderName,
  type Result,
  type SessionOptions,
  type Tokens,
  type Tool,
  type UsageKind,
} from "modelpact/backend";
import { CONTRACT_SCHEMA, describeContract } from "modelpact/testing";

import {
  makeOllamaProvider,
  makePromptApiProvider,
  type OllamaConfig,
} from "../dist/index.js";
import {
  makeWebGpuProvider,
  type EngineChunk,
  type EngineRequest,
  type WebGpuConfig,
  type WebGpuEngine,
} from "../dist/webgpu.js";

export const doorValues = {
  AiError,
  contextUsage,
  createProvider,
  err,
  failureFromError,
  findTool,
  fraction,
  jsonSchema,
  ndjsonLines,
  ok,
  runTool,
  toolThrewFailure,
  tokens,
  CONTRACT_SCHEMA,
  describeContract,
};

export type DoorTypes = [
  AiFailure,
  AiMessage,
  AiProvider,
  AiRole,
  Availability,
  ConnectOptions,
  ContextUsage,
  FailureKind,
  Fraction,
  GenerateRequest,
  JsonSchema,
  Modality,
  ModalityExpectation,
  ModelBackend,
  ModelConnection,
  ModelRequest,
  ProviderName,
  Result<string, AiFailure>,
  SessionOptions,
  Tokens,
  Tool,
  UsageKind,
];

export const ourValues = {
  makeOllamaProvider,
  makePromptApiProvider,
  makeWebGpuProvider,
};

export type OurTypes = [
  OllamaConfig,
  WebGpuConfig,
  WebGpuEngine,
  EngineChunk,
  EngineRequest,
];
