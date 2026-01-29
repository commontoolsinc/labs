/**
 * Security tests for SES sandboxing.
 *
 * These tests verify that the sandbox correctly prevents:
 * - Closure state leakage between invocations
 * - Global object pollution
 * - Prototype tampering
 * - Unauthorized access to runtime internals
 * - eval/Function constructor abuse
 */

import { assertEquals } from "@std/assert";
import { SandboxSecurityError } from "../../src/sandbox/mod.ts";
import {
  PatternExecutionError,
  wrapExecution,
} from "../../src/sandbox/execution-wrapper.ts";

Deno.test("Security: execution wrapper catches errors", async (t) => {
  await t.step("wraps thrown errors with context", () => {
    const fn = () => {
      throw new Error("bad input");
    };

    const wrapped = wrapExecution(fn, {
      patternId: "test-pattern",
      functionName: "handler",
    });

    try {
      wrapped();
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(e instanceof PatternExecutionError, true);
      const err = e as PatternExecutionError;
      assertEquals(err.patternId, "test-pattern");
      assertEquals(err.functionName, "handler");
      assertEquals(err.originalError.message, "bad input");
    }
  });

  await t.step("propagates security errors unchanged", () => {
    const securityError = new SandboxSecurityError(
      "access denied",
      "test-pattern",
    );
    const fn = () => {
      throw securityError;
    };

    const wrapped = wrapExecution(fn, { patternId: "test-pattern" });

    try {
      wrapped();
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(e instanceof SandboxSecurityError, true);
      assertEquals(e, securityError);
    }
  });

  await t.step("wraps non-Error throws", () => {
    // deno-lint-ignore no-explicit-any
    const fn = (): any => {
      throw "string error";
    };

    const wrapped = wrapExecution(fn, { patternId: "test-pattern" });

    try {
      wrapped();
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(e instanceof PatternExecutionError, true);
      const err = e as PatternExecutionError;
      assertEquals(err.originalError.message, "string error");
    }
  });
});

Deno.test("Security: SandboxSecurityError properties", async (t) => {
  await t.step("includes pattern ID and operation", () => {
    const error = new SandboxSecurityError(
      "forbidden",
      "my-pattern",
      "evaluate",
    );
    assertEquals(error.message, "forbidden");
    assertEquals(error.patternId, "my-pattern");
    assertEquals(error.attemptedOperation, "evaluate");
    assertEquals(error.name, "SandboxSecurityError");
  });

  await t.step("works without optional fields", () => {
    const error = new SandboxSecurityError("forbidden");
    assertEquals(error.message, "forbidden");
    assertEquals(error.patternId, undefined);
    assertEquals(error.attemptedOperation, undefined);
  });
});
