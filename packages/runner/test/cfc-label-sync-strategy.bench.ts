/**
 * Guards the `getCfcLabel` sync strategy (runtime-processor `syncMetaLinkedDocs`).
 *
 * `getCfcLabel` is a DISPLAY-label read on the render hot path. It used to
 * re-sync the cell's whole root meta-graph on every call with a SERIAL
 * `await sync()` per node. Split timing put that at ~99.97% of the IPC, bimodal
 * p50 0.1ms / p95 >1s under multi-writer churn: when a node's watch is
 * mid-refresh the `sync()` blocks on a server round-trip, and serial awaits make
 * the cost the SUM of those round-trips along the whole graph. End-to-end the
 * `getCfcLabel` IPC p95 ran 0.5–4.2s at 4 concurrent browser profiles.
 *
 * The fix: skip docs already in the local replica (the renderer is already
 * subscribed to the cells it renders, so they are present — read the current
 * display state without awaiting a refresh), and sync any genuinely cold docs in
 * one parallel batch. End-to-end that dropped the `getCfcLabel` IPC p95 to
 * ~5–11ms.
 *
 * A storage emulator can't reproduce this — it has no network latency and a
 * single replica holds its own writes, so nothing is ever "cold" or mid-refresh.
 * This instead models the cost STRUCTURE the change addresses: each genuine sync
 * is one awaited round-trip (`ROUND_TRIP_MS`); an already-present doc is a Set
 * lookup. The three strategies then show their true asymptotics:
 *   - serial-await     [old] — SUM of round-trips (one per node).
 *   - parallel-batch          — ~one round-trip (all coalesced).
 *   - skip-when-present [new] — zero round-trips when warm; one batch when cold.
 */

import { sleep } from "@commonfabric/utils/sleep";

// Fan-out of a deeply-nested piece's root meta-graph (root + sub-pattern
// surfaces + their argument/pattern docs).
const NODE_COUNT = 32;
// Representative in-flight watch-refresh round-trip under multi-writer churn.
// Real measurements showed ~0.4–1.4s; 2ms keeps the bench fast while preserving
// the serial-sum vs parallel-max vs skip-zero structure.
const ROUND_TRIP_MS = 2;

type Replica = Set<number>;

// One genuine sync = one awaited round-trip; an already-present node is free.
const syncNode = async (replica: Replica, node: number): Promise<void> => {
  if (!replica.has(node)) {
    await sleep(ROUND_TRIP_MS);
    replica.add(node);
  }
};

const warmReplica = (): Replica =>
  new Set(Array.from({ length: NODE_COUNT }, (_, index) => index));
const coldReplica = (): Replica => new Set();

// --- "ensure the whole meta-graph is available" strategies ------------------

const ensureSerial = async (replica: Replica) => {
  for (let node = 0; node < NODE_COUNT; node++) {
    // Old syncMetaLinkedDocs: unconditional, serial await per node.
    await sleep(ROUND_TRIP_MS);
    replica.add(node);
  }
};

const ensureParallel = async (replica: Replica) => {
  await Promise.all(
    Array.from({ length: NODE_COUNT }, async (_, node) => {
      await sleep(ROUND_TRIP_MS);
      replica.add(node);
    }),
  );
};

const ensureSkipWhenPresent = async (replica: Replica) => {
  const cold: number[] = [];
  for (let node = 0; node < NODE_COUNT; node++) {
    if (!replica.has(node)) cold.push(node);
  }
  if (cold.length > 0) {
    await Promise.all(cold.map((node) => syncNode(replica, node)));
  }
};

Deno.bench(
  "syncMetaLinkedDocs (warm) - serial await per node [old]",
  { group: "cfc-label-sync-warm", baseline: true },
  async (b) => {
    const replica = warmReplica();
    b.start();
    await ensureSerial(replica);
    b.end();
  },
);

Deno.bench(
  "syncMetaLinkedDocs (warm) - parallel batch",
  { group: "cfc-label-sync-warm" },
  async (b) => {
    const replica = warmReplica();
    b.start();
    await ensureParallel(replica);
    b.end();
  },
);

Deno.bench(
  "syncMetaLinkedDocs (warm) - skip when present [new]",
  { group: "cfc-label-sync-warm" },
  async (b) => {
    const replica = warmReplica();
    b.start();
    await ensureSkipWhenPresent(replica);
    b.end();
  },
);

Deno.bench(
  "syncMetaLinkedDocs (cold) - serial await per node [old]",
  { group: "cfc-label-sync-cold", baseline: true },
  async (b) => {
    const replica = coldReplica();
    b.start();
    await ensureSerial(replica);
    b.end();
  },
);

Deno.bench(
  "syncMetaLinkedDocs (cold) - skip when present [new]",
  { group: "cfc-label-sync-cold" },
  async (b) => {
    const replica = coldReplica();
    b.start();
    await ensureSkipWhenPresent(replica);
    b.end();
  },
);
