import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TransportNotificationType } from "@/protocol/mod.ts";
import { WebWorkerRuntimeTransport } from "@/client/transports/web-worker/transport-web-worker.ts";

// Exercises the transport's handling of forwarded worker console output
// without a real worker: a fake Worker class lets us construct the transport,
// then we drive its private message handler directly.
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
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

/**
 * Calls `connect()` with the fake worker in place, handing back both the
 * pending connection and the fake the call constructed. Unlike the tests that
 * drive a transport they already hold, one of `connect()` has to reach the
 * worker through the transport it is not given.
 */
function connectWithFakeWorker(): {
  connection: Promise<WebWorkerRuntimeTransport>;
  worker: FakeWorker;
} {
  const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  try {
    // `connect()` constructs the transport before its first `await`, so the
    // swap only has to cover the call itself, not the promise it returns.
    const connection = WebWorkerRuntimeTransport.connect({
      workerUrl: new URL("http://localhost/worker.js"),
    });
    return { connection, worker: FakeWorker.instances[0] };
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

describe("WebWorkerRuntimeTransport", () => {
  describe("ready handshake", () => {
    it("settles `ready()` on the worker's ready notification", async () => {
      const transport = makeTransport();
      let settled = false;
      const ready = transport.ready().then(() => {
        settled = true;
      });

      const handle = handlerOf(transport);

      // Anything else leaves it pending, the notification being the one message
      // that says the worker's entry has run.
      handle(new MessageEvent("message", { data: { msgId: 1 } }));
      await Promise.resolve();
      expect(settled).toBe(false);

      handle(
        new MessageEvent("message", {
          data: { type: TransportNotificationType.WorkerReady },
        }),
      );
      await ready;
      expect(settled).toBe(true);

      await transport.dispose();
    });
  });

  describe("connect()", () => {
    it("terminates the worker when a pre-ready worker error rejects it", async () => {
      // A failed `connect()` never hands the caller a transport, so there is
      // nothing left to call `dispose()` on -- and `dispose()` holds the only
      // `terminate()`. The worker would run for as long as the page did.
      const { connection, worker } = connectWithFakeWorker();

      worker.dispatchEvent(
        new ErrorEvent("error", {
          message: "worker failed to load",
          cancelable: true,
        }),
      );

      await expect(connection).rejects.toThrow("worker failed to load");
      expect(worker.terminated).toBe(true);
    });
  });

  describe("worker-console re-emit", () => {
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
            data: {
              type: TransportNotificationType.WorkerConsole,
              level: "error",
              text: "kaboom",
            },
          }),
        );
        handle(
          new MessageEvent("message", {
            data: {
              type: TransportNotificationType.WorkerConsole,
              level: "warn",
              text: "careful",
            },
          }),
        );

        expect(calls).toEqual([
          ["error", "[worker] kaboom"],
          ["warn", "[worker] careful"],
        ]);
        // Neither was treated as an IPC message.
        expect(emitted).toEqual([]);

        // A level outside the forwarded roster is not this transport's traffic,
        // so it is forwarded on rather than logged. The roster is one constant
        // that the worker's bridge posts from and this transport recognizes by,
        // so nothing the bridge sends can land here.
        const offRoster = {
          type: TransportNotificationType.WorkerConsole,
          level: "fatal",
          text: "not console traffic",
        };
        handle(new MessageEvent("message", { data: offRoster }));
        expect(calls).toHaveLength(2);
        expect(emitted).toEqual([offRoster]);
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
});
