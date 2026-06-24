import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { RuntimeConnection } from "./connection.ts";
import { EventEmitter } from "./emitter.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  RequestType,
} from "../protocol/mod.ts";
import type { RuntimeTransport, RuntimeTransportEvents } from "./transport.ts";

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

  send(message: IPCClientMessage | IPCClientNotification): void {
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

    // Dispose stays pending until the worker confirms its flush (which arrives
    // well within the default request timeout).
    await new Promise((resolve) => setTimeout(resolve, 10));
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

  it("detach() unregisters the teardown", async () => {
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
