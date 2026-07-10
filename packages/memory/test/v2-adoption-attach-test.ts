/**
 * Adoption fan-out scoping (docs/specs/scheduler-v2/
 * incremental-observation-adoption.md §4): which scheduler observation rows a
 * session sync may carry.
 *
 * The doc diff of a push is watch-scoped and reader-scoped; the observation
 * rows riding the same push must obey the same boundary, or a receiver adopts
 * an action it can never verify — and because adoption skips the run that
 * would have loaded and subscribed the action's reads, no later push ever
 * invalidates it (the flag-ON multiUserTest receiver stall). Pinned here:
 *
 * - rows whose reads are not fully inside the session's tracked docs never
 *   ship (the receiver would never get those docs' changes);
 * - rows touching user-scope addresses ship only to sessions of the writer's
 *   principal (same address, per-principal data);
 * - rows touching session-scope addresses ship to no one;
 * - space-scope rows over tracked reads ship to every watching session.
 */

import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Server } from "../v2/server.ts";
import {
  connect,
  loopback,
  type SessionOpenAuthFactory,
  type Transport,
} from "../v2/client.ts";
import type { SchedulerActionObservation } from "../v2/engine.ts";
import {
  decodeMemoryBoundary,
  resetPersistentSchedulerStateConfig,
  type SchedulerActionSnapshotResult,
  type SessionSync,
  setPersistentSchedulerStateConfig,
} from "../v2.ts";
import { testSessionOpenAuth } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-adoption-attach-space";
const ALICE = "did:key:z6Mk-adoption-attach-alice";
const BOB = "did:key:z6Mk-adoption-attach-bob";

const SHARED_DOC = "of:adoption-attach-shared";
const UNTRACKED_DOC = "of:adoption-attach-untracked";
const USER_OUT = "of:adoption-attach-user-out";
const SESSION_OUT = "of:adoption-attach-session-out";

const authFactoryFor = (principal: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal },
});

// Tee a loopback transport: every server->client payload is decoded and, when
// it is a session/effect sync, recorded — the raw wire form keeps the
// `observations` field the WatchView drops.
const teeSyncs = (
  inner: Transport,
  syncs: SessionSync[],
): Transport => ({
  send: (payload) => inner.send(payload),
  close: () => inner.close(),
  setCloseReceiver: (receiver) => inner.setCloseReceiver?.(receiver),
  setReceiver(receiver) {
    inner.setReceiver((payload) => {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        effect?: SessionSync;
      };
      if (message?.type === "session/effect" && message.effect) {
        syncs.push(message.effect);
      }
      receiver(payload);
    });
  },
});

const observationFor = (
  actionId: string,
  overrides: Partial<SchedulerActionObservation> = {},
): SchedulerActionObservation => ({
  version: 1,
  branch: "",
  pieceId: "of:adoption-attach-piece",
  processGeneration: 0,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [{
    space: SPACE,
    scope: "space",
    id: SHARED_DOC,
    path: ["value", "count"],
  }],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
  ...overrides,
});

const attachedActionIds = (
  syncs: readonly SessionSync[],
): string[] =>
  syncs.flatMap((sync) => sync.observations ?? []).map(
    (row: SchedulerActionSnapshotResult) =>
      (row.observation as SchedulerActionObservation).actionId,
  );

Deno.test("memory v2 adoption rows are watch- and reader-scoped like the doc diff", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const server = new Server({
    store: toFileUrl(`${storePath}/`),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });

  const writerClient = await connect({ transport: loopback(server) });
  const aliceSyncs: SessionSync[] = [];
  const aliceClient = await connect({
    transport: teeSyncs(loopback(server), aliceSyncs),
  });
  const bobSyncs: SessionSync[] = [];
  const bobClient = await connect({
    transport: teeSyncs(loopback(server), bobSyncs),
  });

  try {
    const writer = await writerClient.mount(SPACE, {}, authFactoryFor(ALICE));
    const alice = await aliceClient.mount(SPACE, {}, authFactoryFor(ALICE));
    const bob = await bobClient.mount(SPACE, {}, authFactoryFor(BOB));

    // Seed the shared doc, then watch it from both receivers so later commits
    // dirty their sessions.
    let writerSeq = 0;
    const write = async (value: number, observations: {
      schedulerObservation?: SchedulerActionObservation;
    } = {}) => {
      await writer.transact({
        localSeq: ++writerSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: SHARED_DOC,
          value: { value: { count: value } },
        }],
        ...observations,
      });
    };
    await write(0);
    await writer.transact({
      localSeq: ++writerSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: USER_OUT,
        scope: "user",
        value: { value: { ready: true } },
      }, {
        op: "set",
        id: SESSION_OUT,
        scope: "session",
        value: { value: { ready: true } },
      }],
    });

    const watch = async (session: typeof alice) => {
      const view = await session.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [
            {
              id: SHARED_DOC,
              selector: { path: [], schema: false },
            },
            {
              id: USER_OUT,
              scope: "user",
              selector: { path: [], schema: false },
            },
            {
              id: SESSION_OUT,
              scope: "session",
              selector: { path: [], schema: false },
            },
          ],
        },
      }]);
      return view.subscribe();
    };
    const aliceUpdates = await watch(alice);
    const bobUpdates = await watch(bob);

    const step = async (
      value: number,
      observation: SchedulerActionObservation,
    ) => {
      const aliceNext = aliceUpdates.next();
      const bobNext = bobUpdates.next();
      await write(value, { schedulerObservation: observation });
      await aliceNext;
      await bobNext;
    };

    // Space-scope observation over the tracked doc: attached to both.
    await step(1, observationFor("space-scope"));

    // Reads reach outside both sessions' watch: attached to neither, even
    // though the carrying commit's doc change IS pushed.
    await step(
      2,
      observationFor("untracked-read", {
        reads: [{
          space: SPACE,
          scope: "space",
          id: UNTRACKED_DOC,
          path: ["value"],
        }],
      }),
    );

    // Outputs must be inside the receiver's watch too. Otherwise the receiver
    // could adopt clean while still holding an older value for that output.
    await step(
      3,
      observationFor("untracked-output", {
        currentKnownWrites: [{
          space: SPACE,
          scope: "space",
          id: UNTRACKED_DOC,
          path: ["value"],
        }],
      }),
    );

    // The per-run changed-write surface is independently safety-relevant. A
    // dynamic/runtime-mediated output may not be part of currentKnownWrites;
    // it must survive persistence and receive the same watch/scope gates.
    await step(
      4,
      observationFor("untracked-actual-output", {
        actualChangedWrites: [{
          space: SPACE,
          scope: "space",
          id: UNTRACKED_DOC,
          path: ["value"],
        }],
      }),
    );
    await step(
      5,
      observationFor("user-scope-actual-write", {
        actualChangedWrites: [{
          space: SPACE,
          scope: "user",
          id: USER_OUT,
          path: ["value"],
        }],
      }),
    );
    await step(
      6,
      observationFor("session-scope-actual-write", {
        actualChangedWrites: [{
          space: SPACE,
          scope: "session",
          id: SESSION_OUT,
          path: ["value"],
        }],
      }),
    );

    // User-scope write surface: per-principal data, so only the writer's
    // principal (alice) may adopt it.
    await step(
      7,
      observationFor("user-scope-write", {
        currentKnownWrites: [{
          space: SPACE,
          scope: "user",
          id: USER_OUT,
          path: ["value"],
        }],
      }),
    );

    // Session-scope surface: never crosses sessions.
    await step(
      8,
      observationFor("session-scope-write", {
        currentKnownWrites: [{
          space: SPACE,
          scope: "session",
          id: SESSION_OUT,
          path: ["value"],
        }],
      }),
    );

    const aliceAttached = attachedActionIds(aliceSyncs);
    const bobAttached = attachedActionIds(bobSyncs);

    assert(
      aliceAttached.includes("space-scope"),
      `alice missing space-scope row: ${JSON.stringify(aliceAttached)}`,
    );
    assert(
      bobAttached.includes("space-scope"),
      `bob missing space-scope row: ${JSON.stringify(bobAttached)}`,
    );

    assertEquals(aliceAttached.includes("untracked-read"), false);
    assertEquals(bobAttached.includes("untracked-read"), false);
    assertEquals(aliceAttached.includes("untracked-output"), false);
    assertEquals(bobAttached.includes("untracked-output"), false);
    assertEquals(aliceAttached.includes("untracked-actual-output"), false);
    assertEquals(bobAttached.includes("untracked-actual-output"), false);

    assert(
      aliceAttached.includes("user-scope-write"),
      `same-principal receiver must keep user-scope rows: ${
        JSON.stringify(aliceAttached)
      }`,
    );
    assertEquals(bobAttached.includes("user-scope-write"), false);
    assert(aliceAttached.includes("user-scope-actual-write"));
    assertEquals(bobAttached.includes("user-scope-actual-write"), false);

    assertEquals(aliceAttached.includes("session-scope-write"), false);
    assertEquals(bobAttached.includes("session-scope-write"), false);
    assertEquals(aliceAttached.includes("session-scope-actual-write"), false);
    assertEquals(bobAttached.includes("session-scope-actual-write"), false);

    // Boot-listing flavor of the reader gate: the snapshot store keeps one
    // row per actionId, so a user-scope row lists only for the writer's
    // principal (another principal reloading must run fresh over its OWN
    // rows), and session-scope rows list for no one — a reloaded runtime is
    // a new session. The listing is NOT watch-scoped: rehydration itself
    // re-subscribes the observation's reads.
    const listedActionIds = async (session: typeof alice) => {
      const listed = await session.listSchedulerActionSnapshots({
        pieceId: "of:adoption-attach-piece",
      });
      return listed.snapshots.map((row) =>
        (row.observation as SchedulerActionObservation).actionId
      );
    };
    const aliceListed = await listedActionIds(alice);
    const bobListed = await listedActionIds(bob);

    assert(aliceListed.includes("space-scope"));
    assert(aliceListed.includes("untracked-read"));
    assert(
      aliceListed.includes("user-scope-write"),
      `same-principal listing must keep user-scope rows: ${
        JSON.stringify(aliceListed)
      }`,
    );
    assert(aliceListed.includes("user-scope-actual-write"));
    assertEquals(aliceListed.includes("session-scope-write"), false);
    assertEquals(aliceListed.includes("session-scope-actual-write"), false);

    assert(bobListed.includes("space-scope"));
    assertEquals(bobListed.includes("user-scope-write"), false);
    assertEquals(bobListed.includes("user-scope-actual-write"), false);
    assertEquals(bobListed.includes("session-scope-write"), false);
    assertEquals(bobListed.includes("session-scope-actual-write"), false);
  } finally {
    await writerClient.close().catch(() => {});
    await aliceClient.close().catch(() => {});
    await bobClient.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 carries first and changed observation-only rows on the next watched commit", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const server = new Server({
    store: toFileUrl(`${storePath}/`),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const writerClient = await connect({ transport: loopback(server) });
  const receiverSyncs: SessionSync[] = [];
  const receiverClient = await connect({
    transport: teeSyncs(loopback(server), receiverSyncs),
  });

  try {
    const writer = await writerClient.mount(SPACE, {}, authFactoryFor(ALICE));
    const receiver = await receiverClient.mount(
      SPACE,
      {},
      authFactoryFor(ALICE),
    );
    let localSeq = 0;
    await writer.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SHARED_DOC,
        value: { value: { count: 0 } },
      }],
    });
    const view = await receiver.watchSet([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: SHARED_DOC,
          selector: { path: [], schema: false },
        }],
      },
    }]);
    const updates = view.subscribe();
    const syncUpdates = view.subscribeSync();

    const commitObservationOnly = async (
      implementationFingerprint: string,
    ) => {
      await writer.transact({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observationFor("next-window", {
          implementationFingerprint,
        }),
      });
    };
    const commitWatchedWrite = async (count: number) => {
      const next = updates.next();
      const nextSync = syncUpdates.next();
      await writer.transact({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: SHARED_DOC,
          value: { value: { count } },
        }],
      });
      await next;
      await nextSync;
    };

    await commitObservationOnly("impl:first");
    await commitWatchedWrite(1);
    const first = receiverSyncs.flatMap((sync) => sync.observations ?? [])
      .map((row) => row.observation as SchedulerActionObservation)
      .find((row) => row.actionId === "next-window");
    assertEquals(first?.implementationFingerprint, "impl:first");

    receiverSyncs.length = 0;
    await commitObservationOnly("impl:changed");
    await commitWatchedWrite(2);
    const changed = receiverSyncs.flatMap((sync) => sync.observations ?? [])
      .map((row) => row.observation as SchedulerActionObservation)
      .find((row) => row.actionId === "next-window");
    assertEquals(changed?.implementationFingerprint, "impl:changed");

    // A receiver can cross the reserved delivery sequence without a watched
    // document diff — for example, by committing to an untracked document.
    // That empty catch-up must still carry another session's observation;
    // otherwise lastSyncedSeq advances past the row and it is lost forever.
    receiverSyncs.length = 0;
    await commitObservationOnly("impl:empty-catch-up");
    const nextSync = syncUpdates.next();
    await receiver.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: UNTRACKED_DOC,
        value: { value: { count: 1 } },
      }],
    });
    const emptyCatchUp = await nextSync;
    assertEquals(emptyCatchUp.done, false);
    assertEquals(emptyCatchUp.value.upserts, []);
    assertEquals(emptyCatchUp.value.removes, []);
    const carried = (emptyCatchUp.value.observations ?? [])
      .map((row: SchedulerActionSnapshotResult) =>
        row.observation as SchedulerActionObservation
      )
      .find((row: SchedulerActionObservation) =>
        row.actionId === "next-window"
      );
    assertEquals(carried?.implementationFingerprint, "impl:empty-catch-up");
  } finally {
    await writerClient.close().catch(() => {});
    await receiverClient.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});
