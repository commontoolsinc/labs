// F2 acceptance (feed-adversarial-review FA5/FA6): steady-state accepted-commit
// waves — every revision names a doc the Worker replica already holds and no
// held doc's link topology changes — must integrate through exact point reads
// (docs.read) with ZERO graph queries. Cold paths (initial pull, closure
// growth, deletion, leave-the-closure compaction) legitimately traverse.
import { assert, assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, MIME, URI } from "@commonfabric/memory/interface";
import {
  type BranchName,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

class CountingServer extends Server {
  graphQueryCount = 0;
  /** Per-commit transact outcomes: operation ids + rejection name, so a
   * fixture can assert "committed in one attempt, zero conflicts" for the
   * FA5 rerun shape (the W2.8 conflict-exhaustion class). */
  readonly transactOutcomes: { ids: string[]; error?: string }[] = [];
  /** Deterministic delivery hold: while set, docs.read responses wait on the
   * gate — the Worker replica cannot integrate the pending wave. */
  #docsReadGate: Promise<void> | null = null;

  override async graphQuery(
    message: Parameters<Server["graphQuery"]>[0],
  ): ReturnType<Server["graphQuery"]> {
    this.graphQueryCount++;
    return await super.graphQuery(message);
  }

  override async transact(
    message: Parameters<Server["transact"]>[0],
  ): ReturnType<Server["transact"]> {
    const response = await super.transact(message);
    const error = (response as { error?: { name?: string } }).error;
    this.transactOutcomes.push({
      ids: (message.commit.operations ?? []).map((operation) =>
        String((operation as { id?: unknown }).id)
      ),
      ...(error?.name !== undefined ? { error: error.name } : {}),
    });
    return response;
  }

  /** FB13: rejected point reads (dead-lane `laneReadRejection` shape). */
  docsReadRejections = 0;

  override async docsRead(
    message: Parameters<Server["docsRead"]>[0],
  ): ReturnType<Server["docsRead"]> {
    if (this.#docsReadGate !== null) await this.#docsReadGate;
    const response = await super.docsRead(message);
    if (
      (response as { error?: { name?: string } }).error?.name ===
        "ExecutionLeaseFenceError"
    ) {
      this.docsReadRejections++;
    }
    return response;
  }

  gateDocsReads(): () => void {
    const gate = Promise.withResolvers<void>();
    this.#docsReadGate = gate.promise;
    return () => {
      this.#docsReadGate = null;
      gate.resolve();
    };
  }

  transactAttempts(id: string): number {
    return this.transactOutcomes.filter((outcome) => outcome.ids.includes(id))
      .length;
  }

  transactConflicts(id: string): number {
    return this.transactOutcomes.filter((outcome) =>
      outcome.ids.includes(id) && outcome.error === "ConflictError"
    ).length;
  }

  /** F1 traversal attribution for the point-read operation. Absent bucket
   * reads as zero calls so the fixtures can assert deltas from a cold start. */
  docsReadCalls(): number {
    return this.feedStats.traversalByOperation["docs.read"]?.calls ?? 0;
  }

  docsReadManagerReads(): number {
    return this.feedStats.traversalByOperation["docs.read"]?.managerReads ?? 0;
  }

  /** FA5/FB12 wave-vs-demand split sub-buckets of the graph.query bucket. */
  graphQueryTriggerCalls(trigger: "wave" | "demand"): number {
    return this.feedStats.traversalByOperation[`graph.query.${trigger}`]
      ?.calls ?? 0;
  }
}

const linkTo = (id: string, space: MemorySpace) => ({
  "/": { "link@1": { id, path: [], space } },
});

async function setUpLinkedClosure() {
  const principal = await Identity.fromPassphrase(
    `executor point reads ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new CountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-point-reads-test",
    },
  });
  const authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory = (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal: principal.did() },
  });
  const writerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const writer = await writerClient.mount(space, {}, authorizeSessionOpen);
  const channel = createHostProviderChannel({
    server,
    space,
    authorizeSessionOpen,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: principal.did(),
    space,
  });

  const root = "of:executor-point-reads:root" as URI;
  const target = "of:executor-point-reads:target" as URI;
  let localSeq = 0;
  const writerTransact = (
    operations: { op: "set" | "delete"; id: string; value?: unknown }[],
  ) =>
    writer.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: operations.map((operation) =>
        operation.op === "set"
          ? {
            op: "set" as const,
            id: operation.id,
            value: operation.value as { value: FabricValue },
          }
          : { op: "delete" as const, id: operation.id }
      ),
    });

  await writerTransact([
    {
      op: "set",
      id: root,
      value: { value: { child: linkTo(target, space) } },
    },
    { op: "set", id: target, value: { value: { version: 1 } } },
  ]);

  const provider = storage.open(space);
  const rootSchema = {
    type: "object",
    properties: {
      child: {
        type: "object",
        properties: { version: { type: "number" } },
      },
      extra: {
        type: "object",
        properties: { version: { type: "number" } },
      },
    },
  } as const;
  assertEquals(
    (await provider.sync(root, { path: [], schema: rootSchema })).error,
    undefined,
  );
  const targetAddress = {
    id: target,
    type: "application/json" as MIME,
    path: [],
  };
  assertEquals(provider.replica.get(targetAddress)?.is, {
    value: { version: 1 },
  });

  return {
    server,
    writerClient,
    channel,
    storage,
    provider,
    writerTransact,
    space,
    root,
    target,
    targetAddress,
    async close() {
      await storage.close();
      await channel.dispose();
      await writerClient.close();
      await server.close();
    },
  };
}

Deno.test("executor provider integrates steady-state waves via point reads with zero graph queries", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    // The registration pull is the cold path and must have traversed.
    assert(server.graphQueryCount > 0, "initial sync should run graph queries");

    const graphQueriesBefore = server.graphQueryCount;
    const docsReadCallsBefore = server.docsReadCalls();
    const managerReadsBefore = server.docsReadManagerReads();

    // A value-only update to a held doc: the steady-state wave.
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 2 } } },
    ]);
    await storage.acceptedCommitsSettled();

    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 2 },
    });
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a steady-state wave must not trigger graph queries",
    );
    assertEquals(
      server.docsReadCalls() - docsReadCallsBefore,
      1,
      "one point-read batch should cover the wave",
    );
    assert(
      server.docsReadManagerReads() - managerReadsBefore <= 1,
      "at most one point read per notice revision",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider coalesces a steady burst into batched point reads", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    const graphQueriesBefore = server.graphQueryCount;
    const burst = 12;
    for (let version = 2; version <= burst + 1; version++) {
      await writerTransact([
        { op: "set", id: target, value: { value: { version } } },
      ]);
    }
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: burst + 1 },
    });
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a steady burst must not trigger graph queries",
    );
    assert(
      server.docsReadManagerReads() <= burst,
      "point reads are bounded by the burst's revisions",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider closure growth still traverses and delivers the new doc", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  const grown = "of:executor-point-reads:grown" as URI;
  try {
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([
      {
        op: "set",
        id: root,
        value: {
          value: {
            child: linkTo(fixture.target, space),
            extra: linkTo(grown, space),
          },
        },
      },
      { op: "set", id: grown, value: { value: { version: 1 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get({
        id: grown,
        type: "application/json" as MIME,
      })?.is,
      { value: { version: 1 } },
      "the never-held link target must be pulled into the replica",
    );
    assert(
      server.graphQueryCount - graphQueriesBefore > 0,
      "closure growth is a cold path and must traverse",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider leave-the-closure: unlinked docs stop producing reads or deliveries", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, root, target } = fixture;
  try {
    // Drop the link. The shrink policy: a link-topology change routes the
    // owning watch through the cold graph refresh, whose before/after diff
    // carries the remove (F3 will add server-side membership deltas).
    await writerTransact([
      { op: "set", id: root, value: { value: { child: null } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "the unlinked doc must be removed from the replica",
    );

    const graphQueriesBefore = server.graphQueryCount;
    const docsReadCallsBefore = server.docsReadCalls();
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 99 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "a doc outside the closure must not be re-delivered",
    );
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a revision naming no held doc must not trigger graph queries",
    );
    assertEquals(
      server.docsReadCalls() - docsReadCallsBefore,
      0,
      "no unwatched point reads (W2.8 conflict-exhaustion class)",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider leaf deletion is a steady tombstone: delivered without traversal", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target } = fixture;
  try {
    // The target has no outbound links, so deleting it changes no topology:
    // the wave stays steady and the tombstone flows as a deleted upsert.
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([{ op: "delete", id: target }]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "a deleted doc must leave the replica",
    );
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a linkless deletion keeps the closure and must not traverse",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider deletion of a linking doc takes the cold path and drops its subtree", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  try {
    // Deleting the root erases its outbound link set (topology shrink): only
    // a traversal can re-baseline the closure and emit the removes.
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([{ op: "delete", id: root }]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get({
        id: root,
        type: "application/json" as MIME,
      }),
      undefined,
      "the deleted root must leave the replica",
    );
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "the unreachable link target must be removed",
    );
    assert(
      server.graphQueryCount - graphQueriesBefore > 0,
      "deleting a linking doc shrinks the closure and must traverse",
    );
    void space;
  } finally {
    await fixture.close();
  }
});

// FA5/FB12: every executor graph query carries a trigger attribution so the
// server can split the graph.query bucket into wave-triggered (a refresh an
// accepted-commit wave forced) vs demand-triggered (first-demand cold pull /
// new-doc closure growth), each bounded per cold event. Without the split, a
// wave-triggered regression of the F2 floor is indistinguishable from
// legitimate demand-pull growth and the F5 protocol's graph.query criterion
// is unevaluable.
Deno.test("executor provider attributes cold graph queries: first-demand and closure growth as demand, wave-forced refresh as wave", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, writerTransact, space, root, target } = fixture;
  const grown = "of:executor-point-reads:trigger-grown" as URI;
  try {
    // Registration (setUpLinkedClosure's provider.sync) is the first-demand
    // cold pull: every query it ran must be demand-attributed; none may claim
    // wave attribution.
    assert(server.graphQueryCount > 0, "initial sync should run graph queries");
    assertEquals(
      server.graphQueryTriggerCalls("demand"),
      server.graphQueryCount,
      "first-demand registration pulls are demand-triggered",
    );
    assertEquals(server.graphQueryTriggerCalls("wave"), 0);

    // Closure growth: a wave admits a never-held link target. The cold event
    // is demand-triggered (new-doc closure growth) and bounded: exactly one
    // demand query for the single affected watch.
    const demandBefore = server.graphQueryTriggerCalls("demand");
    await writerTransact([
      {
        op: "set",
        id: root,
        value: {
          value: {
            child: linkTo(target, space),
            extra: linkTo(grown, space),
          },
        },
      },
      { op: "set", id: grown, value: { value: { version: 1 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      server.graphQueryTriggerCalls("demand") - demandBefore,
      1,
      "one demand query per closure-growth cold event",
    );
    assertEquals(
      server.graphQueryTriggerCalls("wave"),
      0,
      "closure growth must not claim wave attribution",
    );

    // Wave-forced refresh: dropping a link (closure shrink) re-hydrates the
    // watch through the cold graph path because only a traversal can carry
    // the removes. That query is wave-triggered — and bounded: one wave query
    // for the single affected watch.
    const waveBefore = server.graphQueryTriggerCalls("wave");
    const demandBeforeShrink = server.graphQueryTriggerCalls("demand");
    await writerTransact([
      {
        op: "set",
        id: root,
        value: { value: { child: linkTo(target, space) } },
      },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      server.graphQueryTriggerCalls("wave") - waveBefore,
      1,
      "one wave query per wave-forced (shrink) cold event",
    );
    assertEquals(
      server.graphQueryTriggerCalls("demand") - demandBeforeShrink,
      0,
      "a wave-forced refresh must not claim demand attribution",
    );

    // The split stays a sub-attribution: aggregate = every query above.
    assertEquals(
      server.graphQueryTriggerCalls("demand") +
        server.graphQueryTriggerCalls("wave"),
      server.graphQueryCount,
      "every executor query carries a trigger",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider steady wave delivers when the global watermark already covers it", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    // Advance the global watermark past the upcoming commit with an unrelated
    // read so the wave's dataSeq is already <= appliedSeq when it integrates.
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 2 } } },
    ]);
    const unrelated = "of:executor-point-reads:unrelated" as URI;
    await writerTransact([
      { op: "set", id: unrelated, value: { value: { later: true } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 2 },
    });
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 3 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 3 },
    });
    assertEquals(server.graphQueryCount - graphQueriesBefore, 0);
  } finally {
    await fixture.close();
  }
});

// FA5's named fixture (FB12): "a live claimed action gains a new link-target
// read, the target is later revised, and the rerun commits without a conflict
// loop." Built at the executor-provider level: the closure-holding watch
// stands in for the claimed action's interest set, the storage transaction's
// read-through-the-replica for the rerun's input basis, and the commit's
// confirmed-read seq for the basis the server conflict-checks. What this does
// NOT exercise: the pattern-level claim/settlement machinery around the
// rerun (executor-claim-e2e covers that lifecycle) — the seam pinned here is
// exactly the one FB13's wave-drop poisons: replica currency for a grown
// link target under accepted-commit delivery.
Deno.test("FA5 rerun fixture: a grown link-target is revised and the rerun commits without a conflict loop", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  const gained = "of:executor-point-reads:gained" as URI;
  const output = "of:executor-point-reads:rerun-output" as URI;
  const gainedAddress = {
    id: gained,
    type: "application/json" as MIME,
    path: [],
  };
  try {
    // 1. The live claimed action gains a new link-target read: closure
    //    growth admits `gained` (demand-triggered cold pull).
    await writerTransact([
      {
        op: "set",
        id: root,
        value: {
          value: {
            child: linkTo(fixture.target, space),
            extra: linkTo(gained, space),
          },
        },
      },
      { op: "set", id: gained, value: { value: { version: 1 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(gainedAddress)?.is, {
      value: { version: 1 },
    });

    // 2. The target is later revised; the wake delivers the revision as a
    //    steady point read (zero traversal).
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([
      { op: "set", id: gained, value: { value: { version: 2 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(gainedAddress)?.is, {
      value: { version: 2 },
    });
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "the revision wave must integrate without traversal",
    );

    // 3. The rerun: read the grown target THROUGH THE REPLICA (its basis is
    //    whatever the wave delivered), write the output, commit.
    const tx = storage.edit();
    const read = tx.read({
      space,
      id: gained,
      type: "application/json",
      path: ["value", "version"],
    });
    assertEquals(read.error, undefined);
    assertEquals(
      tx.write(
        { space, id: output, type: "application/json", path: [] },
        { rerunSaw: 2 },
      ).error,
      undefined,
    );
    const committed = await tx.commit();
    assertEquals(committed.error, undefined, "the rerun commit must apply");
    assertEquals(
      server.transactAttempts(output),
      1,
      "the rerun commits in ONE attempt — no conflict loop (W2.8 class)",
    );
    assertEquals(server.transactConflicts(output), 0);
  } finally {
    await fixture.close();
  }
});

// Discrimination control for the fixture above: the SAME rerun shape against
// a replica whose wave delivery is withheld conflicts server-side — proving
// the green fixture binds to delivery currency, not to a vacuous commit path.
// This is the exact staleness FB13's whole-wave drop produces (bob's claimed
// reruns committing against D@old), pinned here at bounded attempts: the
// commit layer surfaces ONE ConflictError, it does not spin.
Deno.test("FA5 rerun fixture control: a withheld wave leaves a stale basis and the rerun conflicts (bounded)", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  const gained = "of:executor-point-reads:gained-stale" as URI;
  const output = "of:executor-point-reads:rerun-output-stale" as URI;
  const gainedAddress = {
    id: gained,
    type: "application/json" as MIME,
    path: [],
  };
  try {
    await writerTransact([
      {
        op: "set",
        id: root,
        value: {
          value: {
            child: linkTo(fixture.target, space),
            extra: linkTo(gained, space),
          },
        },
      },
      { op: "set", id: gained, value: { value: { version: 1 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(gainedAddress)?.is, {
      value: { version: 1 },
    });

    // The rerun reads v1 as its basis…
    const tx = storage.edit();
    assertEquals(
      tx.read({
        space,
        id: gained,
        type: "application/json",
        path: ["value", "version"],
      }).error,
      undefined,
    );
    assertEquals(
      tx.write(
        { space, id: output, type: "application/json", path: [] },
        { rerunSaw: 1 },
      ).error,
      undefined,
    );

    // …then the target is revised while the wave CANNOT integrate (docs.read
    // held): the replica basis is stale by construction.
    const releaseGate = server.gateDocsReads();
    try {
      await writerTransact([
        { op: "set", id: gained, value: { value: { version: 2 } } },
      ]);
      const commitPromise = tx.commit();
      // Release the delivery only once the stale-based commit has reached the
      // server, so the conflict outcome is deterministic, and the post-reject
      // read-repair can then proceed.
      const deadline = Date.now() + 5_000;
      while (server.transactAttempts(output) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      releaseGate();
      const committed = await commitPromise;
      assertExists(committed.error, "a stale basis must conflict");
      assertEquals(
        server.transactConflicts(output),
        1,
        "exactly one ConflictError — the rejection is surfaced, not retried",
      );
      assertEquals(server.transactAttempts(output), 1);
    } finally {
      releaseGate();
    }
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(gainedAddress)?.is, {
      value: { version: 2 },
    });
  } finally {
    await fixture.close();
  }
});

// --- FB13: F2 wave integration x C1.9 lane lifecycle -----------------------
//
// A drained user lane's watches used to keep keying point-read groups: the
// group's docs.read came back `laneReadRejection`, refreshAcceptedCommits
// threw, and the whole spliced-out batch — every watch's deliveries — was
// dropped forever (warn-only). The fixtures below pin the two coordinated
// fixes: (a) per-group isolation with deferred re-queue (surviving groups
// deliver; the failed group's notices are NOT lost), and (b) the lane-drain
// reconcile retiring/re-keying the drained lane's watches so the deferred
// notices heal and nothing stays permanently stale.

const LANE_FLAGS = {
  serverPrimaryExecutionV1: true,
  // context-lattice-claims-v1 is layered above claim routing: both are
  // required for the C1.7 cohort gate to admit user lanes.
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const;

async function setUpLaneClosure() {
  const principal = await Identity.fromPassphrase(
    `executor lane drain ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const alicePrincipal = "did:key:z6Mk-lane-drain-alice";
  const bobPrincipal = "did:key:z6Mk-lane-drain-bob";
  const aliceLane = userExecutionContextKey(alicePrincipal);
  const bobLane = userExecutionContextKey(bobPrincipal);
  const server = new CountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-point-reads-test",
    },
    protocolFlags: LANE_FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  const authorize = (
    did: string,
  ): MemoryClient.SessionOpenAuthFactory =>
  (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal: did },
  });
  const sponsorClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: LANE_FLAGS,
  });
  const sponsor = await sponsorClient.mount(space, {}, authorize(space));
  // Connected anchor sessions for the lane principals, negotiating the
  // context-lattice subcapability (the C1.7 cohort gate).
  const aliceClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: LANE_FLAGS,
  });
  await aliceClient.mount(space, {}, authorize(alicePrincipal));
  const bobClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: LANE_FLAGS,
  });
  await bobClient.mount(space, {}, authorize(bobPrincipal));

  const shared = "of:executor-lane-drain:shared" as URI;
  const sponsorDoc = "of:executor-lane-drain:sponsor" as URI;
  const late = "of:executor-lane-drain:late" as URI;
  let localSeq = 0;
  const transact = (
    operations: { op: "set" | "delete"; id: string; value?: unknown }[],
  ) =>
    sponsor.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: operations.map((operation) =>
        operation.op === "set"
          ? {
            op: "set" as const,
            id: operation.id,
            value: operation.value as { value: FabricValue },
          }
          : { op: "delete" as const, id: operation.id }
      ),
    });
  await transact([
    { op: "set", id: shared, value: { value: { n: 1 } } },
    { op: "set", id: sponsorDoc, value: { value: { n: 1 } } },
    { op: "set", id: late, value: { value: { n: 1 } } },
  ]);

  // The lease-bound executor channel: exact host-only authority, no
  // client-credential path into the Worker.
  await sponsor.setExecutionDemand("", ["piece:lane-drain"]);
  const lease = await server.acquireExecutionLease(space, "");
  assertExists(lease);
  const channel = createHostProviderChannel({
    server,
    space,
    executionLease: lease,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: space,
    space,
    protocolFlags: LANE_FLAGS,
  });
  const provider = storage.open(space);

  const aliceGrant = await server.openUserLaneGrant(
    space,
    "" as BranchName,
    alicePrincipal,
  );
  await server.openUserLaneGrant(space, "" as BranchName, bobPrincipal);

  const selector = { path: [], schema: false as const };
  // Sponsor (context-free) watch first, then alice's lane watch on the
  // shared broad doc. Bob's hydration of the same broad doc is COVERED by
  // alice's watch (lane-effective scope of a broad doc is shared) — the
  // exact C1.9 shape: his replica reads ride the first hydrator's watch.
  assertEquals(
    (await provider.sync(sponsorDoc, selector)).error,
    undefined,
  );
  assertEquals(
    (await provider.replica.runWithExecutionLane!(
      aliceLane,
      () => provider.sync(shared, selector),
    )).error,
    undefined,
  );
  assertEquals(
    (await provider.replica.runWithExecutionLane!(
      bobLane,
      () => provider.sync(shared, selector),
    )).error,
    undefined,
  );

  const docAddress = (id: URI) => ({
    id,
    type: "application/json" as MIME,
    path: [],
  });
  assertEquals(provider.replica.get(docAddress(shared))?.is, {
    value: { n: 1 },
  });
  assertEquals(provider.replica.get(docAddress(sponsorDoc))?.is, {
    value: { n: 1 },
  });

  return {
    server,
    storage,
    provider,
    transact,
    space,
    shared,
    sponsorDoc,
    late,
    selector,
    alicePrincipal,
    aliceLane,
    bobLane,
    aliceGrant,
    docAddress,
    async close() {
      await storage.close();
      await channel.dispose();
      await bobClient.close();
      await aliceClient.close();
      await sponsorClient.close();
      await server.close();
    },
  };
}

Deno.test("FB13: a drained lane's rejected point-read group defers instead of dropping the wave; prune re-keys and heals", async () => {
  const f = await setUpLaneClosure();
  const { server, storage, provider, transact, docAddress } = f;
  try {
    // Baseline: with alice's grant live, one wave revising both docs
    // delivers to her lane-keyed watch and the sponsor's.
    await transact([
      { op: "set", id: f.shared, value: { value: { n: 2 } } },
      { op: "set", id: f.sponsorDoc, value: { value: { n: 2 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(docAddress(f.shared))?.is, {
      value: { n: 2 },
    });
    assertEquals(provider.replica.get(docAddress(f.sponsorDoc))?.is, {
      value: { n: 2 },
    });

    // Alice disconnects; C1.3 drains her lane (pool-driven full drain).
    // Her watch still keys the shared doc's point-read group.
    assert(server.closeUserLaneGrant(f.aliceGrant));

    // One wave revising the shared doc AND the sponsor's doc. The dead
    // lane's group rejects — the sponsor's delivery must SURVIVE (FB13a:
    // no whole-wave drop) and the failed group's notice must be deferred,
    // not lost.
    await transact([
      { op: "set", id: f.shared, value: { value: { n: 3 } } },
      { op: "set", id: f.sponsorDoc, value: { value: { n: 3 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(docAddress(f.sponsorDoc))?.is,
      { value: { n: 3 } },
      "the surviving group must deliver (no whole-wave drop)",
    );
    assertEquals(
      provider.replica.get(docAddress(f.shared))?.is,
      { value: { n: 2 } },
      "the rejected group's doc stays at its last integrated revision",
    );
    assert(
      server.docsReadRejections > 0,
      "the dead lane's read was actually rejected",
    );

    // (a)-only residual, pinned: while the dead watch still keys the group,
    // the deferred notice re-queues and re-fails on the next flush — it is
    // retried (not lost), but cannot heal until (b) prunes the lane.
    const rejectionsBefore = server.docsReadRejections;
    await transact([
      { op: "set", id: f.sponsorDoc, value: { value: { n: 4 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(docAddress(f.sponsorDoc))?.is, {
      value: { n: 4 },
    });
    assertEquals(
      provider.replica.get(docAddress(f.shared))?.is,
      { value: { n: 2 } },
      "the deferred group stays stale while the dead lane keys it",
    );
    assert(
      server.docsReadRejections > rejectionsBefore,
      "the deferred notice was re-attempted (re-queued, not dropped)",
    );

    // (b) the worker-side lane-drain reconcile prunes the lane: the broad
    // watch re-keys onto the context-free/sponsor read path ("a dead lane
    // grant must not starve the shared read") and the deferred notices heal.
    storage.pruneExecutionLane(f.space, f.aliceLane);
    await storage.acceptedCommitsSettled();
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(docAddress(f.shared))?.is,
      { value: { n: 3 } },
      "after the prune the deferred revision must deliver",
    );

    // Steady state again: later waves deliver without rejections.
    const rejectionsAfterHeal = server.docsReadRejections;
    await transact([
      { op: "set", id: f.shared, value: { value: { n: 5 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(docAddress(f.shared))?.is, {
      value: { n: 5 },
    });
    assertEquals(server.docsReadRejections, rejectionsAfterHeal);

    // Alice reconnects: a fresh grant and a clean re-hydration.
    await server.openUserLaneGrant(f.space, "" as BranchName, f.alicePrincipal);
    assertEquals(
      (await provider.replica.runWithExecutionLane!(
        f.aliceLane,
        () => provider.sync(f.shared, f.selector),
      )).error,
      undefined,
    );
    await transact([
      { op: "set", id: f.shared, value: { value: { n: 6 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(docAddress(f.shared))?.is, {
      value: { n: 6 },
    });
  } finally {
    await f.close();
  }
});

Deno.test("FB13: a dead lane's failed COLD refresh is isolated and heals after the prune re-keys the watch", async () => {
  const f = await setUpLaneClosure();
  const { server, storage, provider, transact, docAddress } = f;
  try {
    // Drain alice FIRST, then register a watch under her dead lane: the
    // registration pull rejects but the watch stays registered with no
    // completed pull — the cold-repull candidate FB13 names.
    assert(server.closeUserLaneGrant(f.aliceGrant));
    const registration = await provider.replica.runWithExecutionLane!(
      f.aliceLane,
      () => provider.sync(f.late, f.selector),
    );
    assertExists(
      registration.error,
      "registration under a dead lane must reject",
    );

    // A wave naming the incomplete watch's root AND the sponsor's doc: the
    // cold repull under the dead lane rejects; the sponsor's delivery must
    // survive (pre-fix, the cold-path throw dropped the whole wave too).
    await transact([
      { op: "set", id: f.late, value: { value: { n: 2 } } },
      { op: "set", id: f.sponsorDoc, value: { value: { n: 7 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(docAddress(f.sponsorDoc))?.is,
      { value: { n: 7 } },
      "the steady group must deliver despite the failed cold refresh",
    );
    assertEquals(
      provider.replica.get(docAddress(f.late)),
      undefined,
      "the dead-lane watch's doc is deferred, never half-delivered",
    );

    // The prune re-keys the broad-rooted watch context-free; the deferred
    // notice's cold repull then completes and the doc lands.
    storage.pruneExecutionLane(f.space, f.aliceLane);
    await storage.acceptedCommitsSettled();
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(docAddress(f.late))?.is,
      { value: { n: 2 } },
      "the deferred cold repull must complete after the prune",
    );
  } finally {
    await f.close();
  }
});

Deno.test("FB13: lane drain retires a scoped watch and clears its lane-keyed coverage so re-hydration re-pulls", async () => {
  const f = await setUpLaneClosure();
  const { server, storage, provider } = f;
  const scoped = "of:executor-lane-drain:scoped" as URI;
  try {
    // Alice hydrates a user-scoped doc under her lane (absent-but-tracked is
    // the C1.9b shape). Coverage for a scoped root is lane-keyed.
    assertEquals(
      (await provider.replica.runWithExecutionLane!(
        f.aliceLane,
        () => provider.sync(scoped, f.selector, "user"),
      )).error,
      undefined,
    );
    const queriesAfterFirstPull = server.graphQueryCount;
    // Control: while the lane is live, an identical re-sync is covered.
    assertEquals(
      (await provider.replica.runWithExecutionLane!(
        f.aliceLane,
        () => provider.sync(scoped, f.selector, "user"),
      )).error,
      undefined,
    );
    assertEquals(
      server.graphQueryCount,
      queriesAfterFirstPull,
      "a live-lane re-sync is covered (no re-pull)",
    );

    // Drain + prune: a scoped root is host-unresolvable without the lane
    // grant, so the watch is RETIRED (not re-keyed — resolving it under the
    // sponsor would read the wrong instance) and its coverage cleared.
    assert(server.closeUserLaneGrant(f.aliceGrant));
    storage.pruneExecutionLane(f.space, f.aliceLane);

    // Reconnect: a fresh grant; re-hydration must RE-PULL, not be a covered
    // no-op against phantom coverage of the retired watch.
    await server.openUserLaneGrant(f.space, "" as BranchName, f.alicePrincipal);
    assertEquals(
      (await provider.replica.runWithExecutionLane!(
        f.aliceLane,
        () => provider.sync(scoped, f.selector, "user"),
      )).error,
      undefined,
    );
    assert(
      server.graphQueryCount > queriesAfterFirstPull,
      "post-drain re-hydration must re-register the retired watch",
    );
  } finally {
    await f.close();
  }
});
