import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  getErrorMessage,
  isPatternExecutionError,
  PatternExecutionError,
  SandboxSecurityError,
  wrapAsyncExecution,
  wrapExecution,
} from "../../src/sandbox/mod.ts";

Deno.test("wrapExecution - successful execution", async (t) => {
  await t.step("passes through return value", () => {
    const fn = (x: number) => x * 2;
    const wrapped = wrapExecution(fn, { patternId: "test" });

    const result = wrapped(21);
    assertEquals(result, 42);
  });

  await t.step("passes through multiple arguments", () => {
    const fn = (a: number, b: number) => a + b;
    const wrapped = wrapExecution(fn, { patternId: "test" });

    const result = wrapped(20, 22);
    assertEquals(result, 42);
  });

  await t.step("passes through object return values", () => {
    const fn = () => ({ value: 42, name: "test" });
    const wrapped = wrapExecution(fn, { patternId: "test" });

    const result = wrapped();
    assertEquals(result, { value: 42, name: "test" });
  });
});

Deno.test("wrapExecution - error handling", async (t) => {
  await t.step("wraps thrown Error in PatternExecutionError", () => {
    const fn = () => {
      throw new Error("test error");
    };
    const wrapped = wrapExecution(fn, {
      patternId: "my-pattern",
      functionName: "compute",
    });

    try {
      wrapped();
    } catch (err) {
      assertInstanceOf(err, PatternExecutionError);
      assertEquals(err.patternId, "my-pattern");
      assertEquals(err.functionName, "compute");
      assertEquals(err.originalError.message, "test error");
    }
  });

  await t.step("wraps non-Error throws in PatternExecutionError", () => {
    const fn = () => {
      throw "string error"; // eslint-disable-line no-throw-literal
    };
    const wrapped = wrapExecution(fn, { patternId: "test" });

    try {
      wrapped();
    } catch (err) {
      assertInstanceOf(err, PatternExecutionError);
      assertEquals(err.originalError.message, "string error");
    }
  });

  await t.step("preserves SandboxSecurityError without wrapping", () => {
    const securityError = new SandboxSecurityError("access denied", "test");
    const fn = () => {
      throw securityError;
    };
    const wrapped = wrapExecution(fn, { patternId: "test" });

    assertThrows(
      () => wrapped(),
      SandboxSecurityError,
      "access denied",
    );
  });
});

Deno.test("wrapAsyncExecution - successful execution", async (t) => {
  await t.step("passes through resolved value", async () => {
    const fn = (x: number) => Promise.resolve(x * 2);
    const wrapped = wrapAsyncExecution(fn, { patternId: "test" });

    const result = await wrapped(21);
    assertEquals(result, 42);
  });

  await t.step("handles async/await correctly", async () => {
    const fn = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return "done";
    };
    const wrapped = wrapAsyncExecution(fn, { patternId: "test" });

    const result = await wrapped(1);
    assertEquals(result, "done");
  });
});

Deno.test("wrapAsyncExecution - error handling", async (t) => {
  await t.step("wraps rejected Error in PatternExecutionError", async () => {
    const fn = () => Promise.reject(new Error("async error"));
    const wrapped = wrapAsyncExecution(fn, { patternId: "async-pattern" });

    try {
      await wrapped();
    } catch (err) {
      assertInstanceOf(err, PatternExecutionError);
      assertEquals(err.patternId, "async-pattern");
      assertEquals(err.originalError.message, "async error");
    }
  });

  await t.step("preserves SandboxSecurityError in async", async () => {
    const fn = () =>
      Promise.reject(new SandboxSecurityError("async access denied"));
    const wrapped = wrapAsyncExecution(fn, { patternId: "test" });

    try {
      await wrapped();
    } catch (err) {
      assertInstanceOf(err, SandboxSecurityError);
      assertEquals(err.message, "async access denied");
    }
  });
});

Deno.test("PatternExecutionError - toUserMessage", async (t) => {
  await t.step("generates user-friendly message", () => {
    const err = new PatternExecutionError(
      "Something went wrong",
      "my-pattern",
      new Error("underlying"),
      "calculate",
    );

    const message = err.toUserMessage();
    assertEquals(
      message,
      'Error in pattern "my-pattern" in calculate: underlying',
    );
  });

  await t.step("includes source location when available", () => {
    const err = new PatternExecutionError(
      "Something went wrong",
      "my-pattern",
      new Error("underlying"),
      "calculate",
      { file: "src/pattern.ts", line: 42, column: 10 },
    );

    const message = err.toUserMessage();
    assertEquals(
      message,
      'Error in pattern "my-pattern" in calculate at src/pattern.ts:42:10: underlying',
    );
  });

  await t.step("handles missing optional fields", () => {
    const err = new PatternExecutionError(
      "Something went wrong",
      "my-pattern",
      new Error("underlying"),
    );

    const message = err.toUserMessage();
    assertEquals(message, 'Error in pattern "my-pattern": underlying');
  });
});

Deno.test("isPatternExecutionError", async (t) => {
  await t.step("returns true for PatternExecutionError", () => {
    const err = new PatternExecutionError(
      "test",
      "pattern",
      new Error("orig"),
    );
    assertEquals(isPatternExecutionError(err), true);
  });

  await t.step("returns false for regular Error", () => {
    assertEquals(isPatternExecutionError(new Error("test")), false);
  });

  await t.step("returns false for non-error values", () => {
    assertEquals(isPatternExecutionError("error"), false);
    assertEquals(isPatternExecutionError(null), false);
    assertEquals(isPatternExecutionError(undefined), false);
  });
});

Deno.test("getErrorMessage", async (t) => {
  await t.step("extracts message from PatternExecutionError", () => {
    const err = new PatternExecutionError(
      "test",
      "my-pattern",
      new Error("original"),
      "fn",
    );
    const message = getErrorMessage(err);
    assertEquals(message, 'Error in pattern "my-pattern" in fn: original');
  });

  await t.step("extracts message from SandboxSecurityError", () => {
    const err = new SandboxSecurityError("access denied", "my-pattern");
    const message = getErrorMessage(err);
    assertEquals(
      message,
      'Security error in pattern "my-pattern": access denied',
    );
  });

  await t.step("extracts message from regular Error", () => {
    const err = new Error("something failed");
    const message = getErrorMessage(err);
    assertEquals(message, "something failed");
  });

  await t.step("adds pattern context to regular Error when provided", () => {
    const err = new Error("something failed");
    const message = getErrorMessage(err, "my-pattern");
    assertEquals(message, 'Error in pattern "my-pattern": something failed');
  });

  await t.step("converts non-Error values to string", () => {
    assertEquals(getErrorMessage("string error"), "string error");
    assertEquals(getErrorMessage(42), "42");
    assertEquals(getErrorMessage(null), "null");
  });
});
