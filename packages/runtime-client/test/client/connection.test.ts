import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { getLogger } from "@commonfabric/utils/logger";
import {
  consoleMessageFrom,
  RuntimeConnection,
} from "../../client/connection.ts";
import { EventEmitter } from "../../client/emitter.ts";
import {
  type ConsoleNotification,
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  NotificationType,
  RequestType,
  RuntimeErrorCode,
} from "../../protocol/mod.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "../../client/transport.ts";

/**
 * Transport that records everything sent and auto-acknowledges every request
 * except the types in `holdTypes`, which are left pending (simulating
 * in-flight work).
 */
class FakeTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly sent: Array<IPCClientMessage | IPCClientNotification> = [];
  disposeCalls = 0;

  constructor(private holdTypes: RequestType[] = []) {
    super();
  }

  send(original: IPCClientMessage | IPCClientNotification): void {
    // Cloned, as a real transport delivers it, so what is captured cannot
    // change under later mutation by the sender.
    const message = structuredClone(original);
    this.sent.push(message);
    // Notifications carry no msgId and get no reply.
    if (!("msgId" in message)) return;
    if (this.holdTypes.includes(message.data.type)) return;
    // Acknowledge asynchronously, like a real worker round-trip.
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }

  dispose(): Promise<void> {
    this.disposeCalls++;
    return Promise.resolve();
  }
}

async function initializedConnection(
  transport: FakeTransport,
): Promise<RuntimeConnection> {
  const connection = new RuntimeConnection(transport);
  await connection.initialize({} as InitializationData);
  return connection;
}

describe("connection", () => {
  describe("RuntimeConnection disposal", () => {
    it("settles in-flight requests as cancellation on dispose", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);

      const inFlight = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      // Avoid an unhandled rejection between dispose() and the assertion.
      const settled = inFlight.then(() => undefined, (error) => error);

      await connection.dispose();

      const error = await settled;
      expect(connection.signal.aborted).toBe(true);
      // Cancelled with the standard abort reason, not a bespoke error.
      expect(error).toBe(connection.signal.reason);
      expect((error as { name?: string })?.name).toBe("AbortError");
    });

    it("runs registered teardown synchronously, before transport teardown", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      const order: string[] = [];
      connection.onDispose(() => order.push("teardown"));
      const realDispose = transport.dispose.bind(transport);
      transport.dispose = () => {
        order.push("transport");
        return realDispose();
      };

      await connection.dispose();

      expect(order).toEqual(["teardown", "transport"]);
    });

    it("does not send requests issued after dispose", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      const sentBefore = transport.sent.length;
      const error = await connection
        .request<RequestType.Idle>({ type: RequestType.Idle })
        .then(() => undefined, (e) => e);

      expect(connection.signal.aborted).toBe(true);
      expect(error).toBe(connection.signal.reason);
      // The request never reached the transport.
      expect(transport.sent.length).toBe(sentBefore);
    });

    it("runs teardown immediately when registered after dispose", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      let ran = false;
      connection.onDispose(() => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("is idempotent", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      await connection.dispose();
      await connection.dispose();

      expect(transport.disposeCalls).toBe(1);
    });

    it("waits for the worker to confirm dispose before tearing down", async () => {
      // Hold the Dispose reply: the worker has not yet confirmed its flush.
      const transport = new FakeTransport([RequestType.Dispose]);
      const connection = await initializedConnection(transport);

      let done = false;
      const disposing = connection.dispose().then(() => {
        done = true;
      });

      // Dispose stays pending until the worker confirms its flush. Draining the
      // task queue (all microtasks, then one macrotask) runs every continuation a
      // completed dispose would take; the held Dispose reply never arrives, so a
      // correct dispose is still pending and the transport is untouched.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(done).toBe(false);
      expect(transport.disposeCalls).toBe(0);

      // The worker finishes flushing and replies; teardown then completes.
      const disposeMsg = transport.sent.find(
        (m): m is IPCClientMessage =>
          "msgId" in m && m.data.type === RequestType.Dispose,
      );
      transport.emit("message", { msgId: disposeMsg!.msgId });

      await disposing;
      expect(done).toBe(true);
      expect(transport.disposeCalls).toBe(1);
    });

    it("ignores incoming messages without warning once dead", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.dispose();

      const warnings: unknown[][] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        // A late response for an unknown request, a malformed message, and a
        // stray notification — all ignored silently in the dead state.
        transport.emit("message", { msgId: 9999 });
        transport.emit("message", "garbage" as never);
        transport.emit(
          "message",
          { type: "cell:update", cell: {}, value: 1 } as never,
        );
      } finally {
        console.warn = original;
      }

      expect(warnings.length).toBe(0);
    });

    it("throws when a notification is sent after disposal", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      await connection.dispose();

      const sentBefore = transport.sent.length;
      // Notifications come only from owned consumers torn down before disposal,
      // so a post-disposal send is a contract violation, not a benign race.
      expect(() => session.sendEvent(1, 2, { type: "click" } as never, 3))
        .toThrow();
      expect(() => session.ackBatch(1, 7)).toThrow();
      // Nothing reached the transport.
      expect(transport.sent.length).toBe(sentBefore);
    });
  });

  describe("RuntimeConnection.attachVDom", () => {
    it("runs the consumer teardown on disposal", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      let torn = false;
      connection.attachVDom(() => {
        torn = true;
      });
      await connection.dispose();
      expect(torn).toBe(true);
    });

    it("does not run the teardown after `detach()`", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      let torn = false;
      const session = connection.attachVDom(() => {
        torn = true;
      });
      session.detach();
      await connection.dispose();
      expect(torn).toBe(false);
    });

    it("sends events and acks through the session while alive", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      session.sendEvent(1, 2, { type: "click" } as never, 3);
      session.ackBatch(1, 9);
      const notifications = transport.sent.filter((m) => !("msgId" in m));
      expect(notifications.length).toBe(2);
      session.detach();
    });

    it("mounts, unmounts, and routes batch notifications via the session", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});

      const cellRef = {
        id: "of:mount-cell",
        space: "did:key:test",
        scope: "space",
        path: [],
      };
      // mount/unmount are awaited round-trips, auto-acked by the transport.
      await session.mount(1, cellRef as never);
      await session.unmount(1);
      const sentTypes = transport.sent
        .filter((m): m is IPCClientMessage => "msgId" in m)
        .map((m) => m.data.type);
      expect(sentTypes).toContain(RequestType.VDomMount);
      expect(sentTypes).toContain(RequestType.VDomUnmount);

      // onBatch/offBatch wire and unwire the vdombatch subscription.
      const batches: number[] = [];
      const handler = (n: { batchId: number }) => batches.push(n.batchId);
      session.onBatch(handler as never);
      transport.emit(
        "message",
        { type: "vdom:batch", batchId: 7, ops: [] } as never,
      );
      expect(batches).toEqual([7]);
      session.offBatch(handler as never);
      transport.emit(
        "message",
        { type: "vdom:batch", batchId: 8, ops: [] } as never,
      );
      expect(batches).toEqual([7]);

      session.detach();
    });

    it("skips the unmount round-trip once disposed", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      const session = connection.attachVDom(() => {});
      await connection.dispose();

      const sentBefore = transport.sent.length;
      // The worker tears down every mount wholesale on dispose, so a per-mount
      // unmount is redundant and is skipped.
      await session.unmount(1);
      expect(transport.sent.length).toBe(sentBefore);
    });
  });

  describe("RuntimeConnection request timeline", () => {
    it("records send and settle offsets for boot-window requests", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);
      await connection.request<RequestType.Idle>({ type: RequestType.Idle });

      const timeline = connection.getRequestTimelineDiagnostics();
      expect(timeline.map((entry) => entry.type)).toEqual([
        RequestType.Initialize,
        RequestType.Idle,
      ]);
      for (const entry of timeline) {
        expect(typeof entry.msgId).toBe("number");
        expect(typeof entry.sentAtMs).toBe("number");
        // Both requests settled, so both are stamped done — at or after send.
        expect(typeof entry.doneAtMs).toBe("number");
        expect(entry.doneAtMs!).toBeGreaterThanOrEqual(entry.sentAtMs);
        expect(entry.error).toBeUndefined();
      }
      await connection.dispose();
    });

    it("leaves doneAtMs unset while in flight and flags error replies", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      const inFlight = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      const settled = inFlight.then(() => undefined, (error) => error);

      const pendingEntry = connection.getRequestTimelineDiagnostics()
        .find((entry) => entry.type === RequestType.Idle);
      expect(pendingEntry).toBeDefined();
      expect(pendingEntry!.doneAtMs).toBeUndefined();
      expect(pendingEntry!.error).toBeUndefined();

      // The worker answers with an error; the entry is stamped done + error.
      const sent = transport.sent.find(
        (m): m is IPCClientMessage =>
          "msgId" in m && m.data.type === RequestType.Idle,
      );
      transport.emit("message", { msgId: sent!.msgId, error: "boom" });
      const error = await settled;
      expect((error as Error).message).toBe("boom");

      const doneEntry = connection.getRequestTimelineDiagnostics()
        .find((entry) => entry.type === RequestType.Idle);
      expect(doneEntry!.error).toBe(true);
      expect(typeof doneEntry!.doneAtMs).toBe("number");
      await connection.dispose();
    });

    it("surfaces coded request failures as lifecycle error events", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);
      const errors: unknown[] = [];
      connection.on("error", (error) => errors.push(error));

      const request = connection.request<RequestType.Idle>({
        type: RequestType.Idle,
      });
      const settled = request.then(() => undefined, (error) => error);
      const sent = transport.sent.find(
        (message): message is IPCClientMessage =>
          "msgId" in message && message.data.type === RequestType.Idle,
      );
      transport.emit("message", {
        msgId: sent!.msgId,
        error: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      });

      const error = await settled as Error & { code?: RuntimeErrorCode };
      expect(error.code).toBe(RuntimeErrorCode.CompilerStackLoadFailed);
      expect(errors).toEqual([{
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      }]);
      await connection.dispose();
    });

    it("returns a copy that does not expose the internal ledger", async () => {
      const transport = new FakeTransport();
      const connection = await initializedConnection(transport);

      const first = connection.getRequestTimelineDiagnostics();
      expect(first.length).toBe(1);
      // Mutate the returned array and its entries every way a caller could.
      first[0].type = "mutated" as RequestType;
      first[0].doneAtMs = -1;
      first.push({ msgId: 999, type: RequestType.Idle, sentAtMs: 0 });

      const second = connection.getRequestTimelineDiagnostics();
      expect(second.length).toBe(1);
      expect(second[0].type).toBe(RequestType.Initialize);
      expect(second[0].doneAtMs).not.toBe(-1);
      await connection.dispose();
    });
  });

  describe("RuntimeConnection pending-request diagnostics", () => {
    it("snapshots in-flight requests with their ages, oldest first", async () => {
      const transport = new FakeTransport([RequestType.Idle]);
      const connection = await initializedConnection(transport);

      // Give the two in-flight requests a deterministic age gap without sleeping:
      // freeze performance.now() and step it forward between the sends, so the
      // first request is measurably older. This is what exercises the
      // descending-age sort — with equal ages a stable sort preserves insertion
      // order whichever way the comparator runs, leaving the direction untested.
      const realNow = performance.now;
      let fakeNow = realNow.call(performance);
      Reflect.set(performance, "now", () => fakeNow);
      try {
        const first = connection.request<RequestType.Idle>({
          type: RequestType.Idle,
        });
        const firstSettled = first.then(() => undefined, (error) => error);
        fakeNow += 5;
        const second = connection.request<RequestType.Idle>({
          type: RequestType.Idle,
        });
        const secondSettled = second.then(() => undefined, (error) => error);

        const pending = connection.getPendingRequestDiagnostics();
        expect(pending.length).toBe(2);
        for (const entry of pending) {
          expect(entry.type).toBe(RequestType.Idle);
          expect(typeof entry.msgId).toBe("number");
          expect(entry.ageMs).toBeGreaterThanOrEqual(0);
        }
        // Sorted oldest (largest age) first — the request a stalled caller has
        // been waiting on longest names the wedged layer.
        expect(pending[0].ageMs).toBeGreaterThan(pending[1].ageMs);
        expect(pending[0].msgId).toBeLessThan(pending[1].msgId);

        await connection.dispose();
        await firstSettled;
        await secondSettled;
        // Disposal settled both as cancellation; nothing is pending anymore.
        expect(connection.getPendingRequestDiagnostics()).toEqual([]);
      } finally {
        Reflect.set(performance, "now", realNow);
      }
    });
  });

  describe("RuntimeConnection loop-lag probe", () => {
    it("samples main-thread lag while alive and clears its timer on dispose", async () => {
      const logger = getLogger("runtime-client");
      const lagCountBefore = logger.getTimeStats("loop", "mainLag")?.count ?? 0;

      // Spy on clearInterval: the loop-lag interval is the only interval the
      // connection owns, so dispose must clear exactly one.
      const originalClearInterval = globalThis.clearInterval;
      const cleared: unknown[] = [];
      globalThis.clearInterval = ((id?: number) => {
        cleared.push(id);
        return originalClearInterval(id);
      }) as typeof clearInterval;

      try {
        const transport = new FakeTransport();
        const connection = await initializedConnection(transport);

        // Block the thread past the first 100ms sample: the tick due during the
        // block can only fire late, so the probe records a positive mainLag.
        // (Structure/counter assertion only — the magnitude is not asserted.)
        const end = performance.now() + 110;
        while (performance.now() < end) {
          // busy
        }
        await new Promise((resolve) => setTimeout(resolve, 5));

        const lagCountAfter = logger.getTimeStats("loop", "mainLag")?.count ??
          0;
        expect(lagCountAfter).toBeGreaterThan(lagCountBefore);

        expect(cleared.length).toBe(0);
        await connection.dispose();
        expect(cleared.length).toBe(1);
      } finally {
        globalThis.clearInterval = originalClearInterval;
      }
    });
  });

  describe("FakeTransport", () => {
    it("delivers a message unshared with the sender", () => {
      // `RuntimeTransport.send()` requires the far end to receive a value it
      // owns, which is what lets a handler cede a byte payload rather than copy
      // it. A double that passed the sender's object through would model
      // something no real transport does.
      const transport = new FakeTransport();
      const body = realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 3])),
      );
      const message: IPCClientMessage = {
        msgId: 1,
        data: {
          type: RequestType.UploadBlob,
          space: "did:key:test-space",
          contentType: "image/png",
          body,
        },
      };

      transport.send(message);

      const captured = transport.sent[0];
      expect(captured).not.toBe(message);
      if (
        !("msgId" in captured) || captured.data.type !== RequestType.UploadBlob
      ) {
        throw new Error("Expected the upload request to have been captured.");
      }
      expect(captured.data.body).not.toBe(body);
      // Decode both trees rather than compare identity alone: a shallow copy
      // differs by identity while still sharing the buffer beneath. A decode
      // takes its buffer over, so the sender's tree still decoding after the
      // captured one did is what says the two do not share one.
      expect((fabricFromRealmValue(captured.data.body) as FabricBytes).slice())
        .toEqual(new Uint8Array([1, 2, 3]));
      expect((fabricFromRealmValue(body) as FabricBytes).slice())
        .toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  describe("consoleMessageFrom", () => {
    /** A console notification carrying the given already-encoded arguments. */
    function notification(
      args: ConsoleNotification["args"],
    ): ConsoleNotification {
      return { type: NotificationType.ConsoleMessage, method: "log", args };
    }

    it("returns the arguments decoded, and the rest of the notification intact", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const message = consoleMessageFrom({
        ...notification([bytes, "plain"].map((a) => realmFromFabricValue(a))),
        metadata: { pieceId: "a-piece" },
      });

      expect(message.method).toBe("log");
      expect(message.metadata).toEqual({ pieceId: "a-piece" });
      expect(message.args[0]).toBeInstanceOf(FabricBytes);
      expect(message.args[0]).toEqual(bytes);
      expect(message.args[1]).toBe("plain");
    });

    it("returns a fixed token when the decoder's own failure resists stringifying", () => {
      // A null-prototype object has no `toString` to reach, so `String()`
      // throws on it; deriving the failure's message must not fail in turn.
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
      const message = consoleMessageFrom(notification([
        [["fvr1"], hostile] as unknown as ConsoleNotification["args"][0],
        realmFromFabricValue("after"),
      ]));

      expect(message.args[0]).toEqual({ "/undecodable": "/undecodableError" });
      expect(message.args[1]).toBe("after");
    });

    it("returns `/undecodable` in place of an argument that does not decode", () => {
      // These are a pattern's `console.*` arguments: a log line that arrives
      // damaged beats one that takes the message dispatch down with it.
      const message = consoleMessageFrom(notification([
        realmFromFabricValue("before"),
        ["not-a-marker", 1] as unknown as ConsoleNotification["args"][0],
        realmFromFabricValue("after"),
      ]));

      expect(message.args[0]).toBe("before");
      expect(Object.keys(message.args[1] as object)).toEqual(["/undecodable"]);
      expect(message.args[2]).toBe("after");
    });
  });
});
