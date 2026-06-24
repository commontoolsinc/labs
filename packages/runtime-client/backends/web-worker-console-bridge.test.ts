import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ClientNotificationType, RequestType } from "../protocol/mod.ts";

// The worker entry (`backends/web-worker/index.ts`) installs a `message`
// listener on `self` (which is `globalThis` under Deno) and reads
// `self.postMessage` at call time. We capture posted messages, import the
// module so its listener registers, then drive the handler by dispatching
// `MessageEvent`s — exercising the opt-in console bridge and the request
// branches without spawning a real worker or initializing the runtime.

type Posted = Record<string, unknown> | string;

function dispatch(data: unknown): Promise<void> {
  globalThis.dispatchEvent(new MessageEvent("message", { data }));
  // The handler is async; let its microtasks settle before asserting.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("web worker console bridge", () => {
  it("forwards console output only while enabled and restores native console", async () => {
    const posted: Posted[] = [];
    const realConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const originalPostMessage =
      (globalThis as { postMessage?: unknown }).postMessage;
    (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
      m: Posted,
    ) => {
      posted.push(m);
    };

    try {
      // Importing registers the message listener and posts "READY".
      await import("./web-worker/index.ts");
      expect(posted).toContain("READY");

      const consoleMessages = () =>
        posted.filter(
          (m): m is { __workerConsole: { level: string; text: string } } =>
            typeof m === "object" && m !== null && "__workerConsole" in m,
        ).map((m) => m.__workerConsole);

      // A request before initialization is rejected (not patched yet, so no
      // forwarded copy reaches `posted`).
      posted.length = 0;
      await dispatch({ msgId: 1, data: { type: RequestType.Idle } });
      expect(posted).toEqual([
        { msgId: 1, error: "WorkerRuntime not initialized." },
      ]);
      expect(consoleMessages()).toHaveLength(0);

      // A one-way notification carries no msgId; with no worker it is dropped
      // silently (no response, no error).
      posted.length = 0;
      await dispatch({ type: ClientNotificationType.VDomBatchApplied });
      expect(posted).toEqual([]);

      // Disabling while forwarding is already off is a no-op that still acks
      // and leaves the native console untouched.
      posted.length = 0;
      await dispatch({
        msgId: 9,
        data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
      });
      expect(posted).toEqual([{ msgId: 9 }]);
      expect(console.log).toBe(realConsole.log);

      // Enable forwarding: the worker patches its console and acks.
      posted.length = 0;
      await dispatch({
        msgId: 2,
        data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
      });
      expect(posted).toContainEqual({ msgId: 2 });

      // A second enable is a no-op that still acks; the bridge stays installed.
      posted.length = 0;
      await dispatch({
        msgId: 21,
        data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
      });
      expect(posted).toContainEqual({ msgId: 21 });

      // Now console output is mirrored. Cover each formatting branch.
      posted.length = 0;
      console.log("plain string");
      expect(consoleMessages()).toContainEqual({
        level: "log",
        text: "plain string",
      });

      posted.length = 0;
      console.warn({ a: 1 });
      expect(consoleMessages()).toContainEqual({
        level: "warn",
        text: '{"a":1}',
      });

      posted.length = 0;
      console.error(new Error("boom"));
      const errMsg = consoleMessages().find((m) => m.level === "error");
      expect(errMsg?.text).toContain("boom");

      // A circular value cannot be JSON.stringified; the bridge falls back to
      // String(...) rather than throwing.
      posted.length = 0;
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      console.log(circular);
      expect(consoleMessages()).toContainEqual({
        level: "log",
        text: "[object Object]",
      });

      // A postMessage failure inside the patched method must not throw out of
      // the logging call.
      (globalThis as { postMessage: (m: Posted) => void }).postMessage = () => {
        throw new Error("channel closed");
      };
      expect(() => console.log("survives")).not.toThrow();
      (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
        m: Posted,
      ) => {
        posted.push(m);
      };

      // Disable forwarding: native console is restored, so a subsequent log is
      // not forwarded.
      posted.length = 0;
      await dispatch({
        msgId: 3,
        data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
      });
      expect(posted).toContainEqual({ msgId: 3 });
      expect(console.log).toBe(realConsole.log);

      posted.length = 0;
      console.log("after disable");
      expect(consoleMessages()).toHaveLength(0);

      // A structurally invalid IPC message is rejected with an error response.
      posted.length = 0;
      await dispatch({ msgId: 4, data: { type: "not-a-real-type" } });
      const errorResponse = posted.find(
        (m): m is { msgId: number; error: string } =>
          typeof m === "object" && m !== null && "error" in m,
      );
      expect(errorResponse?.msgId).toBe(4);
      expect(typeof errorResponse?.error).toBe("string");
    } finally {
      console.log = realConsole.log;
      console.warn = realConsole.warn;
      console.error = realConsole.error;
      if (originalPostMessage === undefined) {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      } else {
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      }
    }
  });
});
