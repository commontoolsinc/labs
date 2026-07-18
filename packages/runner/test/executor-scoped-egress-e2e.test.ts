// C2.8 — scoped-lane builtin egress under the lane grant (context-lattice
// OQ6, register row R12): THE fixture of the work order, end-to-end against
// a real memory-v2 Server and a REAL Deno executor Worker.
//
//  (a) A fetch-family builtin over session-scoped inputs classifies
//      broker-required at session rank, claims under the live session lane
//      grant, and the broker executes it under the LANE's acting identity.
//      A FOREIGN principal's commit (bob writing the shared space input)
//      invalidates it, and the recompute performs egress under the lane
//      grant with NO causal-origin check — the OQ6 semantics: the builtin
//      is the lane principal's own standing side effect reacting to
//      anyone's data, exactly as her client executes it today.
//  (d) The user-lane twin at user rank (a user lane with a connected
//      anchor), same foreign-caused semantics.
//  (c) Drained-lane egress: the lane drains while the Worker still holds
//      the claim — after the fence NO egress occurs (the brokered-egress
//      execution point validates the live claim + lane grant host-side)
//      and the claim settles unserved with revoke, exactly like the space
//      lane's permanent failures.
//
// The space lane's sponsor-consent gates are byte-identical throughout —
// their regression e2e is executor-claim-e2e.test.ts's "real Worker settles
// permanent builtin failures" causal-mismatch leg, which stays green
// unchanged next to this file.
import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionSettlement,
  ClientCommit,
  MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  resetServerPrimaryExecutionClaimRankConfig,
  sessionExecutionContextKey,
  setServerPrimaryExecutionClaimRankConfig,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { DenoSpaceExecutorFactory } from "../src/executor/deno-space-executor.ts";
import type { ServerBuiltinActingIdentity } from "../src/executor/server-builtin-channel.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

/** A fetch builtin whose inputs span the lattice: `base` (PerSpace) is the
 * foreign-cause channel any principal can write; `tag` (the scoped input —
 * PerSession or PerUser per leg) forces the builtin's narrowest read scope,
 * and therefore its classification rank AND its result-cell instances, to
 * the scoped lane. */
const scopedFetchProgram = (
  scope: "PerSession" | "PerUser",
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, fetchText, Default, Writable } from 'commonfabric';",
      `import type { ${scope}, PerSpace } from 'commonfabric';`,
      "export default pattern<{",
      "  base: PerSpace<Writable<string | Default<'/lane-initial'>>>;",
      `  tag: ${scope}<Writable<string | Default<'t0'>>>;`,
      "}>(({ base, tag }) => ({",
      "  base,",
      "  tag,",
      "  fetched: fetchText({",
      "    url: base,",
      "    options: { headers: { 'x-scoped-tag': tag } },",
      "  }),",
      "}));",
    ].join("\n"),
  }],
});

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
      protocolFlags: this.flags,
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() ?? space },
      }),
    );
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://scoped-egress-e2e") },
      new LoopbackSessionFactory(server, flags),
    );
  }
}

const awaitBarrier = async <T>(
  pending: Promise<T>,
  label: string,
  events: readonly string[],
  timeoutMs = 30_000,
): Promise<T> => {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out; events: ${
              JSON.stringify(events.slice(-40))
            }`,
          ),
        ),
      timeoutMs,
    ) as unknown as number;
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

for (const laneKind of ["session", "user"] as const) {
  Deno.test(`C2.8 e2e (${laneKind} lane): foreign-caused scoped builtin egress proceeds under the lane grant; a drained lane refuses egress and settles unserved`, async () => {
    setServerPrimaryExecutionClaimRankConfig("session");
    const alice = await Identity.fromPassphrase(
      `scoped egress lane sponsor ${laneKind} ${crypto.randomUUID()}`,
    );
    const bob = await Identity.fromPassphrase(
      `scoped egress foreign principal ${laneKind} ${crypto.randomUUID()}`,
    );
    // The seeder is a THIRD principal so the LANE's scoped instances stay
    // pristine: user scope is per-principal, and a seed run as alice would
    // pre-populate her user instance of the builtin's internal cells (the
    // seed's suppressed-sink memoization state would then mask the lane's
    // own first egress).
    const carol = await Identity.fromPassphrase(
      `scoped egress seeder ${laneKind} ${crypto.randomUUID()}`,
    );
    const space = alice.did();
    const servingOrigin = new URL("https://toolshed.example/");
    const server = new Server({
      authorizeSessionOpen(message) {
        const value = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof value === "string" ? value : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-scoped-egress-e2e" },
      protocolFlags: FLAGS,
      acl: { mode: "off", serviceDids: [space] },
    });
    const events: string[] = [];
    const brokerRequests: Array<{
      url: string;
      headers: [string, string][];
    }> = [];
    /** Requests the fake broker holds in flight until released — the (c)
     * leg drains the lane while one is airborne. */
    const brokerHolds = new Map<string, {
      dispatched: PromiseWithResolvers<void>;
      release: PromiseWithResolvers<void>;
    }>();
    const actingIdentities: ServerBuiltinActingIdentity[] = [];
    const settlements: ActionSettlement[] = [];
    let revokes = 0;
    let executor:
      | Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>>
      | undefined;
    let observerClient: MemoryClient.Client | undefined;
    let bobClient: MemoryClient.Client | undefined;
    let unsubscribeControl = () => {};
    const seedStorage = LoopbackStorageManager.connectTo(server, FLAGS, {
      as: carol,
    });
    const seedRuntime = new Runtime({
      apiUrl: servingOrigin,
      patternEnvironment: { apiUrl: servingOrigin },
      storageManager: seedStorage,
      fetch: () => Promise.reject(new Error("seed must not fetch")),
      externalSinkDisposition: "suppress",
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    try {
      const compiled = await seedRuntime.patternManager.compilePattern(
        scopedFetchProgram(laneKind === "session" ? "PerSession" : "PerUser"),
        { space },
      );
      const tx = seedRuntime.edit();
      const base = seedRuntime.getCell<string>(
        space,
        `scoped-egress-base-${laneKind}`,
        undefined,
        tx,
      );
      base.set("/lane-initial");
      const result = seedRuntime.getCell<Record<string, unknown>>(
        space,
        `scoped-egress-result-${laneKind}`,
        undefined,
        tx,
      );
      const handle = seedRuntime.run(tx, compiled, { base }, result);
      assertEquals((await tx.commit()).error, undefined);
      await handle.pull();
      await seedRuntime.settled();
      await seedRuntime.storageManager.synced();
      await seedRuntime.dispose();

      // Alice's live session: the demand sponsor AND the lane anchor. Its
      // session id names the session lane (CA9: the identity comes from the
      // host's grant machinery, never fabricated).
      observerClient = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: FLAGS,
      });
      const observer = await observerClient.mount(
        space,
        {},
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: alice.did() },
        }),
      );
      await observer.setExecutionDemand("", [result.sourceURI]);
      await observer.watchSet([{
        id: `scoped-egress-watch-${laneKind}`,
        kind: "graph",
        query: {
          roots: [{
            id: result.sourceURI,
            selector: { path: [], schema: true },
          }],
        },
      }]);
      const lease = await server.acquireExecutionLease(space, "");
      assertExists(lease);
      assertEquals(lease.onBehalfOf, alice.did());

      const laneKey = laneKind === "session"
        ? sessionExecutionContextKey(alice.did(), observer.sessionId)
        : userExecutionContextKey(alice.did());
      const laneGrant = laneKind === "session"
        ? await server.openSessionLaneGrant(
          space,
          "",
          alice.did(),
          observer.sessionId,
        )
        : await server.openUserLaneGrant(space, "", alice.did());
      assertEquals(laneGrant.contextKey, laneKey);

      const scopedClaimSet = Promise.withResolvers<void>();
      const scopedCommitSettled = Promise.withResolvers<void>();
      const unservedSettled = Promise.withResolvers<ActionSettlement>();
      let committedScopedSettlements = 0;
      unsubscribeControl = observer.subscribeExecutionControl((event) => {
        events.push(
          event.type === "session.execution.settlement"
            ? `${event.type}:${event.settlement.outcome}:${
              event.settlement.claim.contextKey === laneKey ? "lane" : "other"
            }:${event.settlement.diagnosticCode ?? ""}`
            : `${event.type}:${
              event.type === "session.execution.claim.set"
                ? event.claim.contextKey === laneKey
                  ? `lane:${event.claim.actionKind}`
                  : "other"
                : ""
            }`,
        );
        if (
          event.type === "session.execution.claim.set" &&
          event.claim.contextKey === laneKey &&
          event.claim.actionKind === "effect"
        ) {
          scopedClaimSet.resolve();
        }
        if (event.type === "session.execution.claim.revoke") revokes++;
        if (event.type === "session.execution.settlement") {
          settlements.push(event.settlement);
          if (
            event.settlement.claim.contextKey === laneKey &&
            event.settlement.claim.actionKind === "effect"
          ) {
            if (event.settlement.outcome === "committed") {
              committedScopedSettlements++;
              scopedCommitSettled.resolve();
            }
            if (event.settlement.outcome === "unserved") {
              unservedSettled.resolve(event.settlement);
            }
          }
        }
      });

      const factory = new DenoSpaceExecutorFactory({
        server,
        apiUrl: servingOrigin,
        patternApiUrl: servingOrigin,
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
          serverPrimaryExecutionUserRankCandidates: true,
          serverPrimaryExecutionSessionRankCandidates: true,
        },
        createBuiltinBroker: () => ({
          async fetch(request) {
            brokerRequests.push({
              url: request.url,
              headers: [...new Headers(request.headers).entries()],
            });
            events.push(`broker:${request.url}`);
            const hold = brokerHolds.get(request.url);
            if (hold !== undefined) {
              hold.dispatched.resolve();
              await hold.release.promise;
            }
            return {
              response: new Response(`served:${request.url}`),
              finalUrl: new URL(request.url, servingOrigin),
              redirectCount: 0,
            };
          },
        }),
        authorizeBuiltinRequest: (request) => {
          actingIdentities.push(request.actingIdentity);
          events.push(`authorize:${request.actingIdentity.lane}`);
        },
        onCandidateClaim: (candidate) =>
          events.push(
            `candidate:${candidate.claimKey.contextKey}:${
              candidate.builtinId ?? "-"
            }:${candidate.causalActorMatchesSponsor ?? "-"}`,
          ),
        onCandidateDiagnostic: (diagnostic) =>
          events.push(`diagnostic:${diagnostic.diagnosticCode}`),
      });
      executor = await factory.start({
        space,
        branch: "",
        lease,
        pieces: [result.sourceURI],
        lanes: [{ contextKey: laneKey, pieces: [result.sourceURI] }],
        onCrash(error) {
          events.push(`crash:${error}`);
        },
      });

      // (a)/(d) first half: the scoped-lane builtin claims at the lane's
      // rank and the broker executes it under the LANE identity.
      await awaitBarrier(
        scopedClaimSet.promise,
        `${laneKind}-lane effect claim`,
        events,
      );
      await awaitBarrier(
        scopedCommitSettled.promise,
        `${laneKind}-lane effect settlement`,
        events,
      );
      assertEquals(
        (server.executionStats.claimsIssuedByContextKey[laneKey] ?? 0) > 0,
        true,
        `no ${laneKind}-lane claim was issued`,
      );
      assertEquals(
        brokerRequests.length >= 1,
        true,
        `no broker egress; events: ${JSON.stringify(events.slice(-60))}`,
      );
      assertEquals(brokerRequests[0]!.url, "/lane-initial");
      // Host-derived acting identity is the LANE's (A23: identity enters
      // through the claim's contextKey; no credential crossed the channel).
      assertExists(actingIdentities[0]);
      if (laneKind === "session") {
        assertEquals(actingIdentities[0], {
          lane: "session",
          principal: alice.did(),
          sessionId: observer.sessionId,
        });
      } else {
        assertEquals(actingIdentities[0], {
          lane: "user",
          principal: alice.did(),
        });
      }

      // Quiesce the initial phase so the foreign leg's counters are exact.
      await executor.settle();
      // (a)/(d) second half — THE OQ6 fixture: a FOREIGN principal's commit
      // invalidates the builtin; egress proceeds under the lane grant with
      // NO causal-origin check.
      const brokerCallsBeforeForeign = brokerRequests.length;
      const settledScopedBeforeForeign = committedScopedSettlements;
      bobClient = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: FLAGS,
      });
      const bobSession = await bobClient.mount(
        space,
        {},
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: bob.did() },
        }),
      );
      await bobSession.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: base.sourceURI,
          value: { value: "/lane-foreign" },
        }],
      } as ClientCommit);
      const foreignEgress = Promise.withResolvers<void>();
      const foreignSettled = Promise.withResolvers<void>();
      const settledTarget = settledScopedBeforeForeign + 1;
      const poll = setInterval(() => {
        if (
          brokerRequests.some((request) => request.url === "/lane-foreign")
        ) {
          foreignEgress.resolve();
        }
        if (committedScopedSettlements >= settledTarget) {
          foreignSettled.resolve();
        }
      }, 20);
      try {
        await awaitBarrier(
          foreignEgress.promise,
          `${laneKind}-lane foreign-caused egress`,
          events,
        );
        await awaitBarrier(
          foreignSettled.promise,
          `${laneKind}-lane foreign-caused settlement`,
          events,
        );
      } finally {
        clearInterval(poll);
      }
      assertEquals(
        brokerRequests.length > brokerCallsBeforeForeign,
        true,
        "foreign-caused recompute produced no egress",
      );
      // NO causal-origin check fired: on the SPACE lane this exact wave —
      // bob's origin session mismatching the alice-sponsored lease — makes
      // the Worker egress guard reject `builtin-causal-actor-mismatch` and
      // settle unserved (executor-claim-e2e.test.ts pins that shape). Under
      // the lane grant the recompute egressed ("/lane-foreign" reached the
      // broker) and nothing settled with the sponsor-consent diagnostic.
      assertEquals(
        events.filter((event) =>
          event.includes("builtin-causal-actor-mismatch")
        ),
        [],
        "the sponsor-consent gate fired for a scoped-lane builtin",
      );
      assertEquals(
        settlements.filter((settlement) =>
          settlement.diagnosticCode === "builtin-causal-actor-mismatch"
        ),
        [],
      );
      assertEquals(events.some((event) => event.startsWith("crash:")), false);

      // (c) drained-lane egress: the lane drains while a builtin is IN
      // FLIGHT (a broker request held airborne), so its writeback commit
      // lands after the fence. No egress may occur after the fence, the
      // lane's claim ends revoked, and a later foreign cause produces
      // neither egress nor a re-claim (grant absence declines issuance).
      await executor.settle();
      const heldUrl = "/lane-held";
      const hold = {
        dispatched: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      brokerHolds.set(heldUrl, hold);
      await bobSession.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: base.sourceURI,
          value: { value: heldUrl },
        }],
      } as ClientCommit);
      await awaitBarrier(
        hold.dispatched.promise,
        `${laneKind}-lane held egress dispatch`,
        events,
      );
      // The builtin is airborne. Fence the lane NOW.
      const drained = laneKind === "session"
        ? server.closeSessionLaneGrant(
          laneGrant as Parameters<typeof server.closeSessionLaneGrant>[0],
        )
        : server.closeUserLaneGrant(
          laneGrant as Parameters<typeof server.closeUserLaneGrant>[0],
        );
      assertEquals(drained, true);
      const brokerCallsAtFence = brokerRequests.length;
      const claimsIssuedAtFence =
        server.executionStats.claimsIssuedByContextKey[laneKey] ?? 0;
      hold.release.resolve();
      // The writeback commit now bounces off the engine's lane fence and the
      // claim's authority ends (revoke published by the drain sweep). Wait
      // for the Worker to observe the release.
      const claimReleased = Promise.withResolvers<void>();
      const releasePoll = setInterval(() => {
        if (
          events.some((event) =>
            event.startsWith("diagnostic:commit-rejected") ||
            event.startsWith("diagnostic:claim-authority-lost") ||
            event.includes("server-builtin-claim-not-live")
          )
        ) {
          claimReleased.resolve();
        }
      }, 20);
      try {
        await awaitBarrier(
          claimReleased.promise,
          `${laneKind}-lane post-fence claim release`,
          events,
        );
      } finally {
        clearInterval(releasePoll);
      }
      assertEquals(
        revokes >= 1,
        true,
        "the drained lane's claim was never revoked",
      );
      // A further foreign cause after the fence: no egress, and no re-claim
      // (the grant is gone, so issuance declines — fixture (e)'s emergent
      // rule applied to a DRAINED lane).
      await bobSession.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: base.sourceURI,
          value: { value: "/lane-after-drain" },
        }],
      } as ClientCommit);
      await executor.settle();
      assertEquals(
        brokerRequests.filter((request) =>
          request.url === "/lane-after-drain"
        ),
        [],
        `egress occurred after the lane fence: ${
          JSON.stringify(events.slice(-30))
        }`,
      );
      assertEquals(
        brokerRequests.length,
        brokerCallsAtFence,
        "a broker request was dispatched after the lane fence",
      );
      assertEquals(
        server.executionStats.claimsIssuedByContextKey[laneKey] ?? 0,
        claimsIssuedAtFence,
        "a scoped claim was issued after the lane drained",
      );
      assertEquals(events.some((event) => event.startsWith("crash:")), false);
    } finally {
      unsubscribeControl();
      await executor?.stop();
      await bobClient?.close();
      await observerClient?.close();
      await seedRuntime.dispose().catch(() => undefined);
      await seedStorage.close().catch(() => undefined);
      await server.close();
      resetServerPrimaryExecutionClaimRankConfig();
    }
  });
}
