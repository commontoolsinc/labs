import { describe, it } from "@std/testing/bdd";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { type ErrorNotification, NotificationType } from "@/protocol/mod.ts";
import { expect } from "@std/expect";
import { TransportNotificationType } from "@/protocol/mod.ts";
import { WebWorkerRuntimeTransport } from "@/client/transports/web-worker/transport-web-worker.ts";

// Exercises the transport's handling of forwarded worker console output
// without a real worker: a fake Worker class lets us construct the transport,
// then we drive its private message handler directly.
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

/** A `MessageEvent` carrying `data` as the worker would actually post it. */
function posted(data: unknown): MessageEvent {
  return new MessageEvent("message", {
    data: realmFromFabricValue(data as never),
  });
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
      handle(posted({ msgId: 1 }));
      await Promise.resolve();
      expect(settled).toBe(false);

      handle(
        posted({ type: TransportNotificationType.WorkerReady }),
      );
      await ready;
      expect(settled).toBe(true);

      await transport.dispose();
    });
  });

  describe("an undecodable message", () => {
    it("reports it and leaves the listener standing", () => {
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));
      const handle = handlerOf(transport);

      // Not an encoding at all, which is what a non-conforming sender or a
      // damaged one would deliver. The worker proves each payload encodable
      // before sending, so this should never happen -- the point is what
      // happens if it does.
      handle(new MessageEvent("message", { data: { not: "an encoding" } }));

      expect(emitted).toHaveLength(1);
      const reported = emitted[0] as ErrorNotification;
      expect(reported.type).toBe(NotificationType.ErrorReport);
      expect(reported.message).toContain("Undecodable message");

      // The transport still works afterwards, which is the whole point of
      // reporting rather than throwing out of the listener.
      handle(posted({ msgId: 7, data: { value: true } }));
      expect(emitted).toHaveLength(2);
    });

    it("reports a failure that refuses to be stringified", () => {
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));

      // A decode failure can throw a value with no `toString` to reach, and
      // deriving the report's text must not fail in turn.
      const hostile = new Proxy({}, {
        get() {
          throw Object.create(null);
        },
        ownKeys() {
          return ["x"];
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true };
        },
      });
      handlerOf(transport)(new MessageEvent("message", { data: hostile }));

      expect(emitted).toHaveLength(1);
      expect((emitted[0] as ErrorNotification).message)
        .toContain("Undecodable message");
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
          posted({
            type: TransportNotificationType.WorkerConsole,
            level: "error",
            text: "kaboom",
          }),
        );
        handle(
          posted({
            type: TransportNotificationType.WorkerConsole,
            level: "warn",
            text: "careful",
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
        handle(posted(offRoster));
        expect(calls).toHaveLength(2);
        expect(emitted).toEqual([offRoster]);
      } finally {
        console.log = realConsole.log;
        console.warn = realConsole.warn;
        console.error = realConsole.error;
      }

      // A non-console message still flows through as an emitted IPC message.
      const ipc = { msgId: 7, data: { value: true } };
      handlerOf(transport)(posted(ipc));
      expect(emitted).toContainEqual(ipc);

      await transport.dispose();
    });
  });
});
