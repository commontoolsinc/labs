import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { WebWorkerRuntimeTransport } from "./transports/web-worker/transport-web-worker.ts";

// Exercises the transport's handling of `{ __workerConsole }` messages without
// a real worker: a fake Worker class lets us construct the transport, then we
// drive its private message handler directly.
class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function makeTransport(): WebWorkerRuntimeTransport {
  const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
  try {
    return new WebWorkerRuntimeTransport({
      workerUrl: new URL("http://localhost/worker.js"),
    });
  } finally {
    (globalThis as { Worker: unknown }).Worker = OriginalWorker;
  }
}

function handlerOf(
  transport: WebWorkerRuntimeTransport,
): (event: MessageEvent) => void {
  return (transport as unknown as {
    _handleMessage: (event: MessageEvent) => void;
  })._handleMessage;
}

describe("WebWorkerRuntimeTransport worker-console re-emit", () => {
  it("re-emits forwarded worker console at the matching level and stops", async () => {
    const transport = makeTransport();
    const emitted: unknown[] = [];
    transport.on("message", (m) => emitted.push(m));

    const calls: Array<[string, string]> = [];
    const realConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (m: string) => calls.push(["log", m]);
    console.warn = (m: string) => calls.push(["warn", m]);
    console.error = (m: string) => calls.push(["error", m]);

    try {
      const handle = handlerOf(transport);

      handle(
        new MessageEvent("message", {
          data: { __workerConsole: { level: "error", text: "kaboom" } },
        }),
      );
      handle(
        new MessageEvent("message", {
          data: { __workerConsole: { level: "warn", text: "careful" } },
        }),
      );
      // A level with no matching console method falls back to console.log.
      handle(
        new MessageEvent("message", {
          data: { __workerConsole: { level: "fatal", text: "fallback" } },
        }),
      );

      expect(calls).toEqual([
        ["error", "[worker] kaboom"],
        ["warn", "[worker] careful"],
        ["log", "[worker] fallback"],
      ]);
      // None of these were treated as IPC messages.
      expect(emitted).toEqual([]);
    } finally {
      console.log = realConsole.log;
      console.warn = realConsole.warn;
      console.error = realConsole.error;
    }

    // A non-console message still flows through as an emitted IPC message.
    const ipc = { msgId: 7, data: { value: true } };
    handlerOf(transport)(new MessageEvent("message", { data: ipc }));
    expect(emitted).toContainEqual(ipc);

    await transport.dispose();
  });
});
