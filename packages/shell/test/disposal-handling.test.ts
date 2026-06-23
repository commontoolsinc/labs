import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { XDebuggerView } from "../src/views/DebuggerView.ts";

// Shell components log when a runtime operation fails. When the failure is a
// disposal race (logout, runtime swap) the operation was cancelled, not a
// genuine failure, so the log is suppressed via `this.rt?.signal.aborted`.

function captureConsoleError(): { calls: unknown[][]; restore(): void } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  return { calls, restore: () => (console.error = original) };
}

describe("DebuggerView worker-logger disposal handling", () => {
  // These handlers run fire-and-forget from @click; a disposal-raced rejection
  // must neither log nor escape as an unhandled rejection.
  function debuggerThis(
    aborted: boolean,
    rejecting: () => Promise<void>,
  ): Record<string, unknown> {
    const rt = {
      signal: { aborted },
      resetLoggerBaselines: rejecting,
      setLoggerEnabled: rejecting,
      setLoggerLevel: rejecting,
      getLoggerCounts: rejecting,
    };
    return {
      loggerBaseline: null,
      workerLoggerMetadata: { worker: { enabled: false } },
      getLoggerRegistry: () => ({}),
      debuggerController: { getRuntime: () => ({ runtime: () => rt }) },
      sampleLoggerCounts: () => Promise.resolve(),
    };
  }

  const reject = () =>
    Promise.reject(new DOMException("aborted", "AbortError"));

  function method(name: string) {
    return (XDebuggerView.prototype as unknown as Record<
      string,
      (this: unknown, ...args: unknown[]) => Promise<void>
    >)[name];
  }

  for (
    const [label, name, args] of [
      ["resetBaseline", "resetBaseline", []],
      ["toggleLogger", "toggleLogger", ["worker"]],
      ["setLoggerLevel", "setLoggerLevel", ["worker", "info"]],
    ] as Array<[string, string, unknown[]]>
  ) {
    it(`${label} logs a failure while the runtime is alive`, async () => {
      const spy = captureConsoleError();
      try {
        await method(name).call(debuggerThis(false, reject), ...args);
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(1);
    });

    it(`${label} stays silent when the runtime is disposed`, async () => {
      const spy = captureConsoleError();
      try {
        await method(name).call(debuggerThis(true, reject), ...args);
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(0);
    });
  }
});
