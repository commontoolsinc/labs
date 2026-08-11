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
      "the predecessor to persist its backlog",
    );
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
    expect((await store.load(space)).length).toBe(0);
    revived.close();
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
