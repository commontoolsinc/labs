import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { DebuggerController } from "../src/lib/debugger-controller.ts";
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
  function debuggerView(
    aborted: boolean,
    rejecting: () => Promise<void>,
  ): XDebuggerView {
    const rt = {
      signal: { aborted },
      resetLoggerBaselines: rejecting,
      setLoggerEnabled: rejecting,
      setLoggerLevel: rejecting,
      getLoggerCounts: rejecting,
    };
    const view = new XDebuggerView();
    // The controller stand-in offers only the runtime lookup, which is all
    // the three handlers read from it. Naming `worker` in the metadata is
    // what sends the toggle and level handlers down the worker path.
    view.debuggerController = {
      getRuntime: () => ({ runtime: () => rt }),
    } as unknown as DebuggerController;
    view.accessForTestingOnly.workerLoggerMetadata = {
      worker: { enabled: false, level: "info" },
    };
    return view;
  }

  const reject = () =>
    Promise.reject(new DOMException("aborted", "AbortError"));

  const handlers: Array<[string, (view: XDebuggerView) => Promise<void>]> = [
    ["resetBaseline", (view) => view.accessForTestingOnly.resetBaseline()],
    [
      "toggleLogger",
      (view) => view.accessForTestingOnly.toggleLogger("worker"),
    ],
    [
      "setLoggerLevel",
      (view) => view.accessForTestingOnly.setLoggerLevel("worker", "info"),
    ],
  ];

  for (const [label, call] of handlers) {
    it(`${label} logs a failure while the runtime is alive`, async () => {
      const spy = captureConsoleError();
      try {
        await call(debuggerView(false, reject));
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(1);
    });

    it(`${label} stays silent when the runtime is disposed`, async () => {
      const spy = captureConsoleError();
      try {
        await call(debuggerView(true, reject));
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(0);
    });
  }
});
