/**
 * Tests for v2 remote consumer.
 *
 * Uses a mock WebSocket that connects RemoteConsumer to a local
 * ProviderSession, simulating the server side in-process.
 */

import { assertEquals } from "@std/assert";
import { SpaceV2 } from "../space.ts";
import { ProviderSession } from "../provider.ts";
import { RemoteConnection, RemoteConsumer } from "../remote.ts";
import { decodeCommand, encodeMessage } from "../codec.ts";
import type { InvocationId, ProviderMessage } from "../protocol.ts";

/**
 * Create a mock WebSocket pair: one for the client (RemoteConnection),
 * one simulated server side that processes via ProviderSession.
 *
 * Returns a RemoteConsumer backed by a mock socket that routes to a real
 * ProviderSession, plus controls for simulating network conditions.
 */
function createMockRemoteSetup(options?: {
  /** If true, don't auto-respond to transact — let the test manually control responses */
  manualConfirmation?: boolean;
}) {
  const serverSpace = SpaceV2.open({ url: new URL("memory:server") });
  const serverSession = new ProviderSession(serverSpace);

  // Track pending responses for manual confirmation mode
  const pendingResponses: Array<{
    id: InvocationId;
    response: ProviderMessage;
    deliver: () => void;
  }> = [];

  // Mock WebSocket implementation
  let clientOnMessage: ((event: { data: string }) => void) | null = null;
  let clientOnOpen: (() => void) | null = null;
  let clientOnClose: (() => void) | null = null;
  let mockReadyState = 0; // CONNECTING

  const mockSocket = {
    get readyState() {
      return mockReadyState;
    },
    set readyState(v: number) {
      mockReadyState = v;
    },
    send(data: string) {
      // Decode the command, invoke server provider, send response back
      const wire = decodeCommand(data);
      const response = serverSession.invoke(wire.id, wire.cmd);

      if (options?.manualConfirmation && wire.cmd.cmd === "/memory/transact") {
        // Queue the response for manual delivery
        pendingResponses.push({
          id: wire.id,
          response,
          deliver() {
            const encoded = encodeMessage(response);
            clientOnMessage?.({ data: encoded });
          },
        });
      } else {
        // Auto-respond via queueMicrotask to simulate async network
        const encoded = encodeMessage(response);
        queueMicrotask(() => {
          clientOnMessage?.({ data: encoded });
        });
      }
    },
    close() {
      mockReadyState = 3; // CLOSED
      clientOnClose?.();
    },
    set onmessage(handler: ((event: { data: string }) => void) | null) {
      clientOnMessage = handler;
    },
    get onmessage() {
      return clientOnMessage;
    },
    set onopen(handler: (() => void) | null) {
      clientOnOpen = handler;
    },
    get onopen() {
      return clientOnOpen;
    },
    set onclose(handler: (() => void) | null) {
      clientOnClose = handler;
    },
    get onclose() {
      return clientOnClose;
    },
    set onerror(_handler: (() => void) | null) {/* noop */},
    get onerror() {
      return null;
    },
  };

  // Monkey-patch the global WebSocket constructor
  const OriginalWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class MockWebSocket {
    constructor(_url: string | URL) {
      // Copy all properties from mockSocket to this
      const self = mockSocket;
      // Simulate connection opening
      queueMicrotask(() => {
        mockReadyState = 1; // OPEN
        clientOnOpen?.();
      });
      return self as any;
    }
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
  };

  const connection = new RemoteConnection({
    url: "ws://localhost:8080/api/storage/memory/v2?space=test",
  });
  const consumer = new RemoteConsumer(connection);
  connection.connect();

  let cleaned = false;
  return {
    consumer,
    connection,
    serverSpace,
    serverSession,
    pendingResponses,
    /** Deliver the next queued server response */
    confirmNext() {
      const entry = pendingResponses.shift();
      if (entry) entry.deliver();
    },
    /** Deliver all queued server responses */
    confirmAll() {
      while (pendingResponses.length > 0) {
        pendingResponses.shift()!.deliver();
      }
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        consumer.close();
      } catch { /* already closed */ }
      try {
        serverSession.close();
      } catch { /* already closed */ }
      try {
        serverSpace.close();
      } catch { /* already closed */ }
      globalThis.WebSocket = OriginalWebSocket;
    },
  };
}

/** Wait for the mock WebSocket connection to open. */
function waitForConnection(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

// ─── Basic Transact ──────────────────────────────────────────────────────

Deno.test("remote: transact applies locally and confirms from server", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const result = consumer.transact([
    { op: "set", id: "e1", value: "hello" },
  ]);

  // Local commit is available synchronously
  assertEquals(result.commit.version, 1);
  assertEquals(result.commit.facts.length, 1);
  assertEquals(result.commit.facts[0].fact.id, "e1");

  // Local state updated
  const confirmed = consumer.getConfirmed("e1");
  assertEquals(confirmed !== null, true);
  assertEquals(confirmed!.version, 1);

  // Wait for server confirmation
  const serverCommit = await result.confirmed;
  assertEquals(serverCommit.version, 1);

  cleanup();
});

Deno.test("remote: stacked commits get sequential versions", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  const r2 = consumer.transact([{ op: "set", id: "x", value: "v2" }]);
  const r3 = consumer.transact([{ op: "set", id: "x", value: "v3" }]);

  // Local versions are sequential
  assertEquals(r1.commit.version, 1);
  assertEquals(r2.commit.version, 2);
  assertEquals(r3.commit.version, 3);

  // All server confirmations resolve
  const [c1, c2, c3] = await Promise.all([
    r1.confirmed,
    r2.confirmed,
    r3.confirmed,
  ]);

  assertEquals(c1.version, 1);
  assertEquals(c2.version, 2);
  assertEquals(c3.version, 3);

  cleanup();
});

Deno.test("remote: multiple entities in single transact", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const result = consumer.transact([
    { op: "set", id: "a", value: 1 },
    { op: "set", id: "b", value: 2 },
    { op: "set", id: "c", value: 3 },
  ]);

  assertEquals(result.commit.facts.length, 3);

  assertEquals(consumer.getConfirmed("a")!.version, 1);
  assertEquals(consumer.getConfirmed("b")!.version, 1);
  assertEquals(consumer.getConfirmed("c")!.version, 1);

  await result.confirmed;
  cleanup();
});

// ─── Deferred Confirmation ──────────────────────────────────────────────

Deno.test("remote: deferred confirmation with manual control", async () => {
  const { consumer, confirmNext, pendingResponses, cleanup } =
    createMockRemoteSetup({
      manualConfirmation: true,
    });
  await waitForConnection();

  const result = consumer.transact([
    { op: "set", id: "e1", value: "hello" },
  ]);

  // Local commit is available immediately
  assertEquals(result.commit.version, 1);

  // Server response is queued, not yet delivered
  assertEquals(pendingResponses.length, 1);

  // confirmed is still pending
  let confirmed = false;
  result.confirmed.then(() => {
    confirmed = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(confirmed, false);

  // Deliver the server response
  confirmNext();
  assertEquals(pendingResponses.length, 0);

  const c = await result.confirmed;
  assertEquals(c.version, 1);

  cleanup();
});

Deno.test("remote: multiple deferred confirmations delivered in order", async () => {
  const { consumer, confirmNext, pendingResponses, cleanup } =
    createMockRemoteSetup({
      manualConfirmation: true,
    });
  await waitForConnection();

  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  const r2 = consumer.transact([{ op: "set", id: "y", value: "v2" }]);

  assertEquals(pendingResponses.length, 2);

  // Confirm first
  confirmNext();
  const c1 = await r1.confirmed;
  assertEquals(c1.version, 1);

  // Second still pending
  assertEquals(pendingResponses.length, 1);

  // Confirm second
  confirmNext();
  const c2 = await r2.confirmed;
  assertEquals(c2.version, 2);

  cleanup();
});

// ─── Query ──────────────────────────────────────────────────────────────

Deno.test("remote: query returns local results", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  // Write some data
  const result = consumer.transact([
    { op: "set", id: "q1", value: "data1" },
    { op: "set", id: "q2", value: "data2" },
  ]);
  await result.confirmed;

  // Query locally
  const facts = consumer.query({ "q1": {}, "q2": {} });
  assertEquals(Object.keys(facts).length, 2);
  assertEquals(facts["q1"].value, "data1");
  assertEquals(facts["q2"].value, "data2");

  cleanup();
});

Deno.test("remote: query wildcard returns all entities", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const result = consumer.transact([
    { op: "set", id: "w1", value: 10 },
    { op: "set", id: "w2", value: 20 },
  ]);
  await result.confirmed;

  const facts = consumer.query({ "*": {} });
  assertEquals(Object.keys(facts).length, 2);
  assertEquals(facts["w1"].value, 10);
  assertEquals(facts["w2"].value, 20);

  cleanup();
});

Deno.test("remote: query for non-existent entity returns empty", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const facts = consumer.query({ "no-such": {} });
  assertEquals(Object.keys(facts).length, 0);

  // No pending transacts, safe to cleanup
  cleanup();
});

// ─── Delete ─────────────────────────────────────────────────────────────

Deno.test("remote: delete operation", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const r1 = consumer.transact([{ op: "set", id: "del", value: "exists" }]);
  await r1.confirmed;
  assertEquals(consumer.query({ "del": {} })["del"].value, "exists");

  const r2 = consumer.transact([{ op: "delete", id: "del" }]);
  await r2.confirmed;

  // After delete, querying returns the entity with no value
  const facts = consumer.query({ "del": {} });
  assertEquals(facts["del"].value, undefined);

  cleanup();
});

// ─── Patch ──────────────────────────────────────────────────────────────

Deno.test("remote: patch operation", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const r1 = consumer.transact([
    { op: "set", id: "p", value: { a: 1, b: 2 } },
  ]);
  await r1.confirmed;

  const r2 = consumer.transact([
    {
      op: "patch",
      id: "p",
      patches: [{ op: "replace", path: "/a", value: 10 }],
    },
  ]);
  await r2.confirmed;

  const facts = consumer.query({ "p": {} });
  assertEquals(facts["p"].value, { a: 10, b: 2 });

  cleanup();
});

// ─── Subscribe ──────────────────────────────────────────────────────────

Deno.test("remote: subscribe returns initial state", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const r = consumer.transact([{ op: "set", id: "sub1", value: "initial" }]);
  await r.confirmed;

  const updates: any[] = [];
  const { facts, subscriptionId } = consumer.subscribe(
    { sub1: {} },
    (update) => updates.push(update),
  );

  assertEquals(Object.keys(facts).length, 1);
  assertEquals(facts["sub1"].value, "initial");
  assertEquals(typeof subscriptionId, "string");

  // Wait for subscribe server response before cleanup
  await new Promise((r) => setTimeout(r, 10));
  cleanup();
});

Deno.test("remote: subscribe receives updates on write", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const r1 = consumer.transact([{ op: "set", id: "live", value: "v1" }]);
  await r1.confirmed;

  const updates: any[] = [];
  consumer.subscribe(
    { live: {} },
    (update) => updates.push(update),
  );

  // Write to the subscribed entity
  const r2 = consumer.transact([{ op: "set", id: "live", value: "v2" }]);
  await r2.confirmed;

  assertEquals(updates.length, 1);
  assertEquals(updates[0].commit.version, 2);
  assertEquals(updates[0].revisions.length, 1);
  assertEquals(updates[0].revisions[0].fact.id, "live");

  cleanup();
});

Deno.test("remote: unsubscribe stops updates", async () => {
  const { consumer, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const updates: any[] = [];
  const { subscriptionId } = consumer.subscribe(
    { "unsub-test": {} },
    (update) => updates.push(update),
  );

  const r1 = consumer.transact([{ op: "set", id: "unsub-test", value: "v1" }]);
  await r1.confirmed;
  assertEquals(updates.length, 1);

  consumer.unsubscribe(subscriptionId);

  const r2 = consumer.transact([{ op: "set", id: "unsub-test", value: "v2" }]);
  await r2.confirmed;
  // Should still be 1 since we unsubscribed
  assertEquals(updates.length, 1);

  // Wait for unsubscribe server response before cleanup
  await new Promise((r) => setTimeout(r, 10));
  cleanup();
});

// ─── Server State Consistency ───────────────────────────────────────────

Deno.test("remote: server space reflects committed state", async () => {
  const { consumer, serverSpace, cleanup } = createMockRemoteSetup();
  await waitForConnection();

  const result = consumer.transact([
    { op: "set", id: "s1", value: "server-visible" },
  ]);

  // Server processes synchronously inside mock send(), so data is
  // already committed even before the response microtask fires
  const serverValue = serverSpace.read("s1");
  assertEquals(serverValue, "server-visible");

  await result.confirmed;
  cleanup();
});

// ─── Cleanup ─────────────────────────────────────────────────────────────

Deno.test("remote: close cleans up connection", async () => {
  const { cleanup } = createMockRemoteSetup();
  await waitForConnection();

  // cleanup calls consumer.close() which closes connection, then cleans up server
  // Should not throw
  cleanup();
});

Deno.test("remote: close with pending transacts resolves confirmations", async () => {
  const { consumer, pendingResponses, cleanup } = createMockRemoteSetup({
    manualConfirmation: true,
  });
  await waitForConnection();

  const result = consumer.transact([{ op: "set", id: "e1", value: "hi" }]);
  assertEquals(pendingResponses.length, 1);

  // Close without confirming — confirmed promise resolves (local state committed)
  consumer.close();

  // Should resolve without error (not reject)
  await result.confirmed;

  // cleanup is idempotent, handles already-closed resources
  cleanup();
});
