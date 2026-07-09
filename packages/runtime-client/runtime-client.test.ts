import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { RuntimeClient } from "./runtime-client.ts";
import { NotificationType, RequestType } from "./protocol/mod.ts";
import type { RuntimeTransport } from "./client/transport.ts";

describe("RuntimeClient.initialize option validation", () => {
  it("rejects an unknown renderDeclassificationPolicy loudly", async () => {
    // The policy is a security knob: a typo'd host config must surface as the
    // host's own error instead of silently flipping the worker to a fallback.
    // The check throws before the transport is used, so a stub suffices.
    const transport = {
      send: () => {
        throw new Error("transport must not be used");
      },
      dispose: () => Promise.resolve(),
      ready: () => Promise.resolve(),
      on: () => {},
      off: () => {},
    } as unknown as RuntimeTransport;
    const identity = await Identity.fromPassphrase(
      "runtime-client-option-validation",
    );

    await expect(
      RuntimeClient.initialize(transport, {
        apiUrl: new URL("http://localhost:9/"),
        identity,
        spaceDid: identity.did(),
        renderDeclassificationPolicy: "allow-all" as never,
      }),
    ).rejects.toThrow("Invalid renderDeclassificationPolicy");
  });
});

describe("RuntimeClient.signal", () => {
  it("exposes the connection's lifetime signal", () => {
    const signal = new AbortController().signal;
    // The constructor only wires event listeners and stores the connection, so
    // a connection stub with on()/signal is enough to read the getter through.
    const conn = { on: () => {}, signal } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    expect(client.signal).toBe(signal);
  });
});

describe("RuntimeClient.setForwardWorkerConsole", () => {
  // The constructor only wires `on()` listeners and stores the connection, so a
  // stub that records requests is enough to assert the IPC the method sends.
  function clientWithRequestStub(): {
    client: RuntimeClient;
    requests: unknown[];
  } {
    const requests: unknown[] = [];
    const conn = {
      on: () => {},
      request: (message: unknown) => {
        requests.push(message);
        return Promise.resolve(undefined);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    return { client, requests };
  }

  it("sends a SetForwardWorkerConsole request to enable forwarding", async () => {
    const { client, requests } = clientWithRequestStub();
    await client.setForwardWorkerConsole(true);
    expect(requests).toEqual([
      { type: RequestType.SetForwardWorkerConsole, enabled: true },
    ]);
  });

  it("sends a SetForwardWorkerConsole request to disable forwarding", async () => {
    const { client, requests } = clientWithRequestStub();
    await client.setForwardWorkerConsole(false);
    expect(requests).toEqual([
      { type: RequestType.SetForwardWorkerConsole, enabled: false },
    ]);
  });
});

describe("RuntimeClient.hasPendingWrites", () => {
  // The constructor registers connection listeners; capture them so the
  // pending-writes notification can be driven directly, no worker needed.
  function clientWithConnHandlers(): {
    client: RuntimeClient;
    handlers: Map<string, (data: unknown) => void>;
  } {
    const handlers = new Map<string, (data: unknown) => void>();
    const conn = {
      on: (event: string, handler: (data: unknown) => void) => {
        handlers.set(event, handler);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    return { client, handlers };
  }

  it("mirrors a pending-writes notification into a synchronous flag and event", () => {
    const { client, handlers } = clientWithConnHandlers();
    const onChange = handlers.get("pendingwriteschange");
    expect(onChange).toBeDefined();

    const emitted: boolean[] = [];
    client.on("pendingwriteschange", ({ pending }) => emitted.push(pending));

    // Defaults to false, and reflects each transition synchronously — the
    // property a beforeunload handler relies on (no async round-trip possible).
    expect(client.hasPendingWrites()).toBe(false);

    onChange!({ type: NotificationType.PendingWritesChanged, pending: true });
    expect(client.hasPendingWrites()).toBe(true);

    onChange!({ type: NotificationType.PendingWritesChanged, pending: false });
    expect(client.hasPendingWrites()).toBe(false);

    expect(emitted).toEqual([true, false]);
  });
});

describe("RuntimeClient boot-window diagnostics", () => {
  // Both getters are main-thread snapshots forwarded straight from the
  // connection (no worker round-trip), so a connection stub pins the wiring.
  it("exposes pending-request and request-timeline snapshots", () => {
    const pending = [{ msgId: 7, type: RequestType.Idle, ageMs: 12 }];
    const timeline = [
      { msgId: 7, type: RequestType.Idle, sentAtMs: 3, doneAtMs: 8 },
    ];
    const conn = {
      on: () => {},
      getPendingRequestDiagnostics: () => pending,
      getRequestTimelineDiagnostics: () => timeline,
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    expect(client.getPendingRequests()).toEqual(pending);
    expect(client.getRequestTimeline()).toEqual(timeline);
  });
});
