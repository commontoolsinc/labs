/**
 * Performance benchmarks for SES sandboxing.
 *
 * Run with: deno bench packages/runner/test/sandbox/performance.bench.ts --allow-env --allow-read
 */

import {
  classifyFrame,
  classifyStack,
  createErrorMapper,
  filterFrames,
  mapError,
} from "../../src/sandbox/mod.ts";
import { wrapExecution } from "../../src/sandbox/execution-wrapper.ts";

// --- Frame Classification Benchmarks ---

const SAMPLE_FRAME = "    at myHandler (pattern.ts:10:5)";
const SAMPLE_STACK = `Error: Test error
    at myHandler (pattern.ts:10:5)
    at eval (recipe-abc.js:4:52)
    at AMDLoader.resolveModule (recipe-abc.js:1:1764)
    at Engine.exec (/harness/engine.ts:50:10)
    at validate (https://esm.sh/zod@3.0.0/index.js:50:10)`;

Deno.bench("classifyFrame - single frame", () => {
  classifyFrame(SAMPLE_FRAME);
});

Deno.bench("classifyStack - 5 frames", () => {
  classifyStack(SAMPLE_STACK);
});

Deno.bench("classifyStack + filterFrames", () => {
  const frames = classifyStack(SAMPLE_STACK);
  filterFrames(frames, false);
});

// --- Error Mapping Benchmarks ---

Deno.bench("mapError - simple error", () => {
  const error = new Error("test");
  error.stack = SAMPLE_STACK;
  mapError(error);
});

Deno.bench("ErrorMapper - reuse instance", () => {
  const mapper = createErrorMapper(false);
  const error = new Error("test");
  error.stack = SAMPLE_STACK;
  mapper.mapError(error);
});

// --- Execution Wrapper Benchmarks ---

const noopFn = () => 42;
const wrappedNoop = wrapExecution(noopFn, {
  patternId: "bench-pattern",
  functionName: "noop",
});

Deno.bench("wrapExecution - no error (hot path)", () => {
  wrappedNoop();
});

Deno.bench("wrapExecution - setup cost", () => {
  const wrapped = wrapExecution(noopFn, {
    patternId: "bench-pattern",
    functionName: "noop",
  });
  wrapped();
});
