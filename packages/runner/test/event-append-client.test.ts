// Server-execution v2 Phase 3 (events-down), client half: the
// event-append queue (events.md §5; speculation.md §5; LT9) and the
// fire-time discrimination (protocol.md §1's scheduler tell).
//
// - the queue discharges in FIRED ORDER, one in flight, and classifies
//   outcomes: delivered; duplicate-above-the-horizon AS delivered
//   (events.md §5's duplicate-submission rule — the named
//   `EventAppendDuplicateError` survives the wire for exactly this);
//   deterministic refusals dropped loudly; transient failures retried
//   with backoff, order preserved.
// - LT9 durability rides the injectable store seam: a queue built over
//   the same store as a dead predecessor discharges the predecessor's
//   intents first, in their fired order.
// - the fire fork commits ONLY for OUTSIDE-the-scheduler sends (the
//   root fire); a handler's cascade send during the echo commits
//   NOTHING (the server's authoritative run owns the durable cascade).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { ClientCommit } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EventAppendQueue,
  type EventAppendQueueStore,
  memoryEventAppendQueueStore,
  type QueuedEventAppend,
  webStorageEventAppendQueueStore,
} from "../src/storage/event-append-queue.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("event append space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("event append alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const appendOf = (
  eventId: string,
): Omit<QueuedEventAppend, "clientSeq"> => ({
  sidecarId: `of:stream-events:${eventId}`,
  stream: { id: "of:stream", path: ["s"] },
  eventId,
  payload: { eventId },
});

describe("event-append queue (events.md §5, LT9)", () => {
  it("discharges in fired order, one in flight", async () => {
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.push((commit.eventAppends ?? [])[0]?.eventId ?? "?");
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    const first = queue.enqueue(appendOf("evt-1"));
    const second = queue.enqueue(appendOf("evt-2"));
    await waitUntil(() => sent.length === 1, "the head to send");
    // Strict serialization: evt-2 must NOT send while evt-1 is in
    // flight (fired-order discharge, events.md §5).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual(["evt-1"]);
    release!();
    await first;
    await waitUntil(() => sent.length === 2, "the second to send");
    expect(sent).toEqual(["evt-1", "evt-2"]);
    release!();
    expect(await second).toEqual({ delivered: true });
    queue.close();
  });

  it("classifies outcomes: duplicate-as-delivered; deterministic refusal dropped; transient retried in place", async () => {
    const outcomes: Array<string> = [];
    let failures = 0;
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        const eventId = (commit.eventAppends ?? [])[0]?.eventId ?? "?";
        outcomes.push(`send:${eventId}`);
        if (eventId === "evt-dup") {
          return Promise.reject(
            namedError(
              "EventAppendDuplicateError",
              "duplicates a stream entry",
            ),
          );
        }
        if (eventId === "evt-bad") {
          return Promise.reject(
            namedError("ProtocolError", "undeclared event append"),
          );
        }
        if (eventId === "evt-flaky" && failures < 2) {
          failures += 1;
          return Promise.reject(
            namedError("ConnectionError", "memory client closed"),
          );
        }
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      onRefused: (append) => outcomes.push(`refused:${append.eventId}`),
    });
    // The duplicate resolves DELIVERED — re-raising would re-discharge
    // forever (events.md §5).
    expect(await queue.enqueue(appendOf("evt-dup"))).toEqual({
      delivered: true,
      deduped: true,
    });
    // The deterministic refusal drops the intent, loudly.
    const refused = await queue.enqueue(appendOf("evt-bad"));
    expect(refused.delivered).toBe(false);
    expect(outcomes).toContain("refused:evt-bad");
    // The transient failure retries the SAME head until it lands —
    // nothing behind it jumps the order.
    const flaky = queue.enqueue(appendOf("evt-flaky"));
    const after = queue.enqueue(appendOf("evt-after"));
    expect(await flaky).toEqual({ delivered: true });
    expect(await after).toEqual({ delivered: true });
    const sends = outcomes.filter((o) => o.startsWith("send:"));
    expect(sends.slice(-4)).toEqual([
      "send:evt-flaky",
      "send:evt-flaky",
      "send:evt-flaky",
      "send:evt-after",
    ]);
    queue.close();
  });

  it("duplicate-eventId fires each settle their own outcome (the per-entry keying — a per-id map would wedge the pending-commit barrier)", async () => {
    let calls = 0;
    const queue = new EventAppendQueue({
      space,
      transact: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve() : Promise.reject(
          namedError("EventAppendDuplicateError", "duplicate"),
        );
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    const first = queue.enqueue(appendOf("evt-same"));
    const second = queue.enqueue(appendOf("evt-same"));
    expect(await first).toEqual({ delivered: true });
    expect(await second).toEqual({ delivered: true, deduped: true });
    queue.close();
  });

  it("the server catch-all 'TransactionError' is TRANSIENT — a fault clears on resend, never losing the intent", async () => {
    let failures = 0;
    const queue = new EventAppendQueue({
      space,
      transact: () => {
        if (failures < 1) {
          failures += 1;
          return Promise.reject(
            namedError("TransactionError", "sqlite I/O fault"),
          );
        }
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    expect(await queue.enqueue(appendOf("evt-fault"))).toEqual({
      delivered: true,
    });
    queue.close();
  });

  it("close() settles every outstanding outcome (a pending-commit barrier holding one must release at teardown)", async () => {
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
    });
    const pending = queue.enqueue(appendOf("evt-stuck"));
    await waitUntil(() => queue.pending.length === 1, "the entry to queue");
    queue.close();
    const outcome = await pending;
    expect(outcome.delivered).toBe(false);
    // The intent itself stays persisted for a successor queue.
    expect(queue.pending.length).toBe(1);
  });

  it("an enqueue AFTER close settles its outcome and keeps the intent persisted for a successor (review 2026-08-11 n2)", async () => {
    // close() sweeps the outcome map; without the enqueue-side belt a
    // post-close enqueue's promise hung forever — wedging any
    // pending-commit barrier it joined. The INTENT still persists
    // (closed is not refused): the next queue instance discharges it.
    const store = memoryEventAppendQueueStore();
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
      store,
    });
    queue.close();
    const outcome = await queue.enqueue(appendOf("evt-late"));
    expect(outcome.delivered).toBe(false);
    expect(queue.pending.length).toBe(1);
    await queue.persisted;
    expect((await store.load(space)).map((entry) => entry.eventId)).toEqual([
      "evt-late",
    ]);
  });

  it("saves serialize behind the PREVIOUS save (review 2026-08-11 m6/LT9): an async adapter can never complete snapshots out of order", async () => {
    // Pre-fix, #persist chained each save on the LOAD only: two rapid
    // enqueues issued two store.save calls back to back, and an
    // adapter resolving them out of order left the OLDER snapshot
    // durable. The pin: a save never STARTS while the previous one is
    // in flight.
    let manual = true;
    const parked: Array<{ snapshot: string[]; resolve: () => void }> = [];
    let saveCalls = 0;
    const store: EventAppendQueueStore = {
      load: () => Promise.resolve([]),
      save: (_space, entries) => {
        saveCalls += 1;
        if (!manual) return Promise.resolve();
        return new Promise<void>((resolve) => {
          parked.push({
            snapshot: entries.map((entry) => entry.eventId),
            resolve,
          });
        });
      },
    };
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
    });
    void queue.enqueue(appendOf("evt-a"));
    void queue.enqueue(appendOf("evt-b"));
    // Two persists are owed. Only the FIRST save may start while it is
    // unresolved.
    await waitUntil(() => saveCalls === 1, "the first save to start");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(saveCalls).toBe(1);
    // Resolving the first releases the second — strictly after, with
    // the final queue state.
    parked[0].resolve();
    await waitUntil(() => saveCalls === 2, "the second save to start");
    expect(parked[1].snapshot).toEqual(["evt-a", "evt-b"]);
    manual = false;
    parked[1].resolve();
    await queue.persisted;
    queue.close();
  });

  it("LT9: intents persisted by a dead predecessor discharge FIRST, in fired order, from the shared store", async () => {
    const store: EventAppendQueueStore = memoryEventAppendQueueStore();
    // Predecessor: everything fails transient — the intents stay queued
    // (and persisted) at close.
    const dead = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
      store,
    });
    void dead.enqueue(appendOf("evt-old-1"));
    void dead.enqueue(appendOf("evt-old-2"));
    await waitUntil(
      () => dead.pending.length === 2,
      "the predecessor to queue its backlog",
    );
    await dead.persisted;
    dead.close();

    // Successor over the SAME store: the reloaded intents discharge
    // ahead of the fresh fire, in their fired order, and clientSeq
    // continues past the persisted ones (one session's append order).
    const sent: string[] = [];
    const revived = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.push((commit.eventAppends ?? [])[0]?.eventId ?? "?");
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
    });
    await revived.loaded;
    expect(await revived.enqueue(appendOf("evt-new"))).toEqual({
      delivered: true,
    });
    expect(sent).toEqual(["evt-old-1", "evt-old-2", "evt-new"]);
    // Everything delivered ⇒ the store drained (a queue that empties).
    // Durability is OBSERVED through `persisted` (its documented
    // purpose): the settle-side saves are chained, not synchronous.
    await revived.persisted;
    expect((await store.load(space)).length).toBe(0);
    revived.close();
  });

  it("a fire racing the backlog load never re-uses a persisted clientSeq (verdict blocker, 2026-08-12): allocation waits for the load", async () => {
    const store: EventAppendQueueStore = memoryEventAppendQueueStore();
    // Persist a backlog with clientSeqs 0 and 1.
    await store.save(space, [
      { ...appendOf("evt-persisted-0"), clientSeq: 0 },
      { ...appendOf("evt-persisted-1"), clientSeq: 1 },
    ]);
    // A store whose LOAD is slow: the fire arrives mid-load.
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const slowStore: EventAppendQueueStore = {
      load: async (loadSpace) => {
        await gate;
        return store.load(loadSpace);
      },
      save: (saveSpace, entries) => store.save(saveSpace, entries),
    };
    const sent: number[] = [];
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        const entry = ((commit.operations[0] as {
          patches?: Array<{ values?: Array<{ firedAt?: { clientSeq?: number } }> }>;
        }).patches ?? [])[0]?.values?.[0];
        sent.push(entry?.firedAt?.clientSeq ?? -1);
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store: slowStore,
    });
    // Fire BEFORE the load completes. Pre-fix this allocated clientSeq 0
    // synchronously — colliding with evt-persisted-0's.
    const outcome = queue.enqueue(appendOf("evt-racing"));
    releaseLoad();
    expect(await outcome).toEqual({ delivered: true });
    await waitUntil(() => sent.length === 3, "all three to discharge");
    // Persisted 0, 1 first (fired order), then the racer at an UNUSED
    // seq (2) — never a duplicate.
    expect(sent).toEqual([0, 1, 2]);
    expect(new Set(sent).size).toBe(3);
    queue.close();
  });

  it("webStorageEventAppendQueueStore round-trips FabricValue payloads (symbols included) through the memory boundary codec; an empty save clears the key", async () => {
    const backing = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    };
    const store = webStorageEventAppendQueueStore(fakeStorage, "did:test:me");
    const entries: QueuedEventAppend[] = [
      { ...appendOf("evt-a"), clientSeq: 0 },
      {
        ...appendOf("evt-b"),
        clientSeq: 1,
        payload: { tag: Symbol.for("cf:test-tag"), n: 2 },
      },
    ];
    await store.save(space, entries);
    expect(backing.size).toBe(1);
    const loaded = await store.load(space);
    expect(loaded.length).toBe(2);
    expect(loaded[0].eventId).toBe("evt-a");
    expect(loaded[1].clientSeq).toBe(1);
    expect((loaded[1].payload as { tag: symbol }).tag).toBe(
      Symbol.for("cf:test-tag"),
    );
    // Scope partitions principals sharing one origin.
    const other = webStorageEventAppendQueueStore(fakeStorage, "did:test:you");
    expect((await other.load(space)).length).toBe(0);
    // A drained queue clears its key (a queue that empties, LT9).
    await store.save(space, []);
    expect(backing.size).toBe(0);
    expect((await store.load(space)).length).toBe(0);
  });

  it("a successor queue over a WEB-STORAGE store discharges a dead predecessor's intents with NO fresh fire (reload self-start; LT9)", async () => {
    const backing = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    };
    const store = webStorageEventAppendQueueStore(fakeStorage, "did:test:me");
    const dead = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
      store,
    });
    void dead.enqueue(appendOf("evt-reload-1"));
    await waitUntil(() => dead.pending.length === 1, "the intent to queue");
    await dead.persisted;
    dead.close();

    const sent: string[] = [];
    const revived = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.push((commit.eventAppends ?? [])[0]?.eventId ?? "?");
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
    });
    // NO enqueue: the constructor's load must kick the discharge.
    await waitUntil(() => sent.length === 1, "the reload self-start");
    expect(sent).toEqual(["evt-reload-1"]);
    await revived.persisted;
    expect(backing.size).toBe(0);
    revived.close();
  });
});

describe("intent outcome consumption (events.md §5's client signal)", () => {
  // Destination-level pins over a stub runtime: the notice scan, the
  // retirement calls, the subscriber signal, and the sink release —
  // the "client MUST be signaled" machinery (events.md §5) that the
  // e2e suites exercise only incidentally (the watermark backstop
  // also retires echoes there, so without these pins the mechanism
  // was feature-deletion-survivable).
  it("consequenced retires; dropped/errored retire AND signal; the sidecar sink releases with its last tracked id", async () => {
    const { SpeculationOverlayDestination } = await import(
      "../src/speculation/overlay-destination.ts"
    );
    const sinks = new Map<
      string,
      { cb: (value: unknown) => void; cancelled: boolean }
    >();
    const runtimeStub = {
      getCellFromLink: (link: { id: string }) => ({
        sink: (cb: (value: unknown) => void) => {
          const record = { cb, cancelled: false };
          sinks.set(link.id, record);
          return () => {
            record.cancelled = true;
          };
        },
      }),
      storageManager: { open: () => ({ replica: {} }) },
    } as never;
    const destination = new SpeculationOverlayDestination(runtimeStub);
    const outcomes: string[] = [];
    const unsubscribe = destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    const SPACE = "did:key:stub" as never;

    destination.trackIntent(SPACE, "of:stream-events:a", "evt-1");
    destination.trackIntent(SPACE, "of:stream-events:a", "evt-2");
    destination.trackIntent(SPACE, "of:stream-events:a", "evt-3");
    expect(sinks.has("of:stream-events:a")).toBe(true);

    const feed = (entries: unknown[]) =>
      sinks.get("of:stream-events:a")!.cb({ entries });
    // consequenced: retires silently (no outcome signal).
    feed([{ eventId: "evt-1", consequenced: true }]);
    // errored: retires AND signals.
    feed([
      { eventId: "evt-1", consequenced: true },
      { eventId: "evt-2", consequenced: true, error: "boom" },
    ]);
    // dropped: retires AND signals; the LAST tracked id releases the
    // sink.
    feed([
      { eventId: "evt-1", consequenced: true },
      { eventId: "evt-2", consequenced: true, error: "boom" },
      { eventId: "evt-3", status: "dropped", reason: "gone" },
    ]);
    expect(outcomes).toEqual(["errored:evt-2", "dropped:evt-3"]);
    expect(sinks.get("of:stream-events:a")!.cancelled).toBe(true);

    // The refusal path (a deterministic admission refusal at
    // discharge): retires + signals without any store state.
    destination.trackIntent(SPACE, "of:stream-events:b", "evt-r");
    destination.resolveIntent(SPACE, "of:stream-events:b", "evt-r", {
      kind: "refused",
      reason: "undeclared",
    });
    expect(outcomes).toEqual([
      "errored:evt-2",
      "dropped:evt-3",
      "refused:evt-r",
    ]);
    expect(sinks.get("of:stream-events:b")!.cancelled).toBe(true);
    unsubscribe();
    destination.close();
  });
});

describe("the fire fork (protocol.md §1's scheduler tell)", () => {
  let server: MemoryV2Server.Server;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a root fire commits ONE append; a handler's cascade send during the echo commits NOTHING (the server owns the durable cascade)", async () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    // Two chained handlers: firing `first` cascades into `second`.
    const CASCADE_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const secondHandler = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
      ");",
      "const firstHandler = handler<",
      "  unknown,",
      "  { value: Writable<number>; second: Stream<unknown> }",
      ">((_ev, { value, second }) => {",
      "  value.set((value.get() ?? 0) + 1);",
      "  second.send({});",
      "});",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; first: Stream<unknown>; second: Stream<unknown> }",
      ">(({ value }) => {",
      "  const second = secondHandler({ value });",
      "  return { value, first: firstHandler({ value, second }), second };",
      "});",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: CASCADE_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "cascade-arg",
      undefined,
    );
    const result = clientRuntime.getCell<
      { value: number; first: unknown; second: unknown }
    >(
      space,
      "cascade-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const before = Engine.serverSeq(engine);
    result.key("first").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The echo ran the WHOLE cascade locally (1 + 10)...
    await waitUntil(
      () => (argument.key("value").get() as number | undefined) === 11,
      "the cascade echo to render",
    );
    // ...but the store received exactly ONE authored commit — the ROOT
    // fire's append. The cascade send happened inside a
    // scheduler-stamped run, and scheduler work commits nothing
    // client-side (protocol.md §1's tell; events.md §2).
    const records = Engine.selectCommitsSince(engine, { fromSeq: before });
    expect(records.length).toBe(1);
    const sidecars = Engine.selectPendingStreamEventDocs(engine);
    expect(sidecars.length).toBe(1);
    expect(sidecars[0].entries.length).toBe(1);
    cancelDemand();
  });
});
