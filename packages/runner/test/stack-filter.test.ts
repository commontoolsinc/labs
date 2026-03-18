import { assertEquals, assertThrows } from "@std/assert";
import { sanitizeUserVisibleStack } from "../src/scheduler.ts";
import {
  assertNoInternalRuntimeFrames,
  normalizeMappedStack,
} from "./support/stack-filter.ts";

Deno.test("sanitizeUserVisibleStack strips relative internal runner frames", () => {
  const stack = [
    "Error: boom",
    "    at eval (piece/main.tsx:4:8)",
    "  at action (packages/runner/src/runner.ts:1597:44)",
    "  at packages/runner/src/scheduler.ts:1037:25",
    "  at SESRuntime.withMappedErrors (packages/runner/src/sandbox/ses-runtime.ts:213:14)",
    "  at Engine.invoke (packages/runner/src/harness/engine.ts:213:35)",
    "  at callback (ext:deno_web/02_timers.js:42:7)",
  ].join("\n");

  assertEquals(
    sanitizeUserVisibleStack(stack),
    [
      "Error: boom",
      "    at eval (piece/main.tsx:4:8)",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ].join("\n"),
  );
});

Deno.test("normalizeMappedStack ignores relative internal and test helper frames", () => {
  const stack = [
    "Error: boom",
    "    at Object.boom (piece/main.tsx:3:8)",
    "  at packages/runner/test/sandbox/differential-runtime.test.ts:49:28",
    "  at packages/runner/test/support/runtime-compare.ts:52:36",
    "  at SESRuntime.withMappedErrors (packages/runner/src/sandbox/ses-runtime.ts:213:14)",
    "  at SESRuntime.invoke (packages/runner/src/sandbox/ses-runtime.ts:91:17)",
    "  at Engine.invoke (packages/runner/src/harness/engine.ts:213:35)",
    "  at captureError (packages/runner/test/support/runtime-compare.ts:369:5)",
  ].join("\n");

  assertEquals(normalizeMappedStack(stack), [
    "Error: boom",
    "    at Object.boom (piece/main.tsx:3:8)",
  ]);
});

Deno.test("assertNoInternalRuntimeFrames rejects relative internal runner frames", () => {
  const stack = [
    "Error: boom",
    "  at action (packages/runner/src/runner.ts:1597:44)",
  ].join("\n");

  assertThrows(
    () => assertNoInternalRuntimeFrames(stack),
    Error,
    "Unexpected internal runtime frame",
  );
});
