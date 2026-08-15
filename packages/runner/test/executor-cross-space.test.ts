// Server-execution v2 Phase 5 — cross-space serving
// (docs/specs/server-side-execution/serving-loop.md §3b's cross-space
// bullet; protocol.md §2, §2b; builtins.md §5's per-demanding-identity
// wish resolution):
//
// - a home derivation reads a FOREIGN doc through the serving runtime's
//   ordinary storage plane, and a foreign commit WAKES the home loop
//   (the server-internal wake — never home input: W stays put, the
//   derived value still updates);
// - home-space resolution on a serving runtime targets the RUN's
//   demanding identity, never the service identity (the lunch-wall
//   trap), and refuses loudly with no identity;
// - the producer-side fail-closed refusal: a serving manager's FOREIGN
//   providers refuse scoped reads (protocol.md §2's grant-scoped read
//   design — delegated scoped reads are fail-closed until grant
//   resolution lands).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime, spaceCellSchema } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { selectForeignStaleInstances } from "../src/executor/space-server.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { ACLManager } from "../src/acl-manager.ts";
import { wish as wishBuiltin } from "../src/builtins/wish.ts";
import {
  replaceSchedulerBasisRows,
  selectForeignBasisRows,
} from "@commonfabric/memory/v2/scheduler-basis";
import { selectDocHead } from "@commonfabric/memory/v2/engine";
import { UI } from "../src/builder/types.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const homeSigner = await Identity.fromPassphrase("cross-space home");
const homeSpace = homeSigner.did() as MemorySpace;
const foreignSigner = await Identity.fromPassphrase("cross-space foreign");
const foreignSpace = foreignSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("cross-space service");
const aliceSigner = await Identity.fromPassphrase("cross-space alice");
const bobSigner = await Identity.fromPassphrase("cross-space bob");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Phase 5 cross-space serving", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async (space) => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          // Phase 5: the serving manager declares its home space so
          // its FOREIGN providers refuse scoped reads (the producer
          // half of the delegated-scoped-read fail-closed rule).
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a foreign commit WAKES the home loop: the home derivation over a foreign doc re-derives without home input (serving-loop.md §3b's server-internal wake)", async () => {
    host = newHost();

    // Seed the FOREIGN input doc (bob's space) before the home loop
    // activates, so the first derivation reads a real value.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    const bobInput = bobRuntime.getCell<{ n: number }>(
      foreignSpace,
      "x-space-input",
      undefined,
    );
    {
      const tx = bobRuntime.edit();
      bobInput.withTx(tx).set({ n: 1 });
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
    }
    await bobRuntime.storageManager.synced();

    // The serving graph: a HOME pattern whose argument is the FOREIGN
    // doc — the home derivation reads across the space boundary
    // (serving-loop.md §3b: reads cross freely; the result commits
    // HOME, protocol.md §2b's derive-from-foreign row).
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 100) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      const foreignArgument = runtime.getCell<{ n: number }>(
        foreignSpace,
        "x-space-input",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        homeSpace,
        "x-space-result",
        compiled.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await foreignArgument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, compiled, foreignArgument, result);
        const committed = await tx.commit();
        if (committed.error === undefined) break;
        if (attempt >= 4) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.idle();
    };

    // The client's DEMAND on the HOME result activates the home space.
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const clientResult = clientRuntime.getCell<{ total: number }>(
      homeSpace,
      "x-space-result",
      undefined,
    );
    let observed: number | undefined;
    const cancel = clientResult.sink((value) => {
      observed = value?.total;
    });
    try {
      await waitUntil(
        () => observed === 101,
        `first derivation over the foreign input (saw ${observed})`,
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);

      // The FOREIGN commit: bob updates his own space. No home input
      // follows — the wake chain (foreign session frames → autonomous
      // scheduler re-run → seal-wake) must start the re-derivation
      // well before the idle window (10 minutes here) expires.
      {
        const tx = bobRuntime.edit();
        bobInput.withTx(tx).set({ n: 2 });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      }
      await waitUntil(
        () => observed === 102,
        `re-derivation after the foreign commit (saw ${observed})`,
      );
    } finally {
      cancel();
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("home-space resolution on a serving runtime targets the RUN's demanding identity, never the service identity (builtins.md §5, RULED 2026-08-14)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      // A stamped run acting for alice: home space = ALICE's DID space.
      const stamped = serving.edit();
      stampWaveRunContext(stamped, {
        actionId: "wish/test",
        kind: "derivation",
        scopeKeyIdentity: {
          principal: aliceSigner.did(),
          sessionId: "sess-1",
        },
      });
      expect(serving.homeSpacePrincipalFor(stamped)).toBe(aliceSigner.did());
      expect(serving.getHomeSpaceCell(stamped).space).toBe(aliceSigner.did());
      stamped.abort(new Error("test-only"));

      // A handler run's stamped ACTOR resolves the same way.
      const handler = serving.edit();
      stampWaveRunContext(handler, {
        actionId: "handler/test",
        kind: "event-handler",
        eventId: "e-1",
        acting: { user: bobSigner.did(), session: "sess-2" },
      });
      expect(serving.homeSpacePrincipalFor(handler)).toBe(bobSigner.did());
      handler.abort(new Error("test-only"));

      // NO demanding identity: undefined, and the cell resolution
      // REFUSES — never the service DID (the lunch-wall trap).
      const unstamped = serving.edit();
      expect(serving.homeSpacePrincipalFor(unstamped)).toBeUndefined();
      expect(() => serving.getHomeSpaceCell(unstamped)).toThrow(
        "per-demanding-identity",
      );
      unstamped.abort(new Error("test-only"));

      // A CLIENT runtime keeps today's behavior: its own user, tx or
      // not.
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: SharedServerStorageManager.connectTo(server, {
          as: aliceSigner,
        }),
      });
      try {
        expect(client.homeSpacePrincipalFor(undefined)).toBe(
          aliceSigner.did(),
        );
        expect(client.getHomeSpaceCell().space).toBe(aliceSigner.did());
      } finally {
        await client.storageManager.close();
        await client.dispose();
      }
    } finally {
      await serving.dispose();
      await manager.close();
    }
  });

  it("the activation foreign re-mark judges recorded foreign inputs against their OWN space's head (serving-loop.md §6 step 2; the F5 pin)", async () => {
    // The re-mark's activation arm fail-degrades to a warn by design
    // (recovery correctness rides recompute-on-demand), so a breakage
    // is invisible there — the decision helper carries the test
    // surface: rows behind their foreign head re-mark, rows AT head do
    // not, home-scan findings are not double-added, and only foreign
    // rows are selected at all.
    const homeEngine = await server.engineForSpace(homeSpace);

    // A real foreign doc with a real head: bob writes it twice.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    try {
      const doc = bobRuntime.getCell<{ n: number }>(
        foreignSpace,
        "f5-foreign-input",
        undefined,
      );
      {
        const tx = bobRuntime.edit();
        doc.withTx(tx).set({ n: 1 });
        expect((await tx.commit()).error).toBeUndefined();
      }
      await bobRuntime.storageManager.synced();
      const docId = doc.getAsNormalizedFullLink().id;
      const foreignEngine = await server.engineForSpace(foreignSpace);
      const headAtRead = selectDocHead(foreignEngine, {
        id: docId,
        scopeKey: "space",
      });
      expect(headAtRead).toBeGreaterThan(0);

      // Recorded basis rows on the HOME engine: action-current read the
      // doc at its current head; action-behind at head-1; action-covered
      // is already in the home scan's stale set; action-home reads only
      // a home entity (never selected as foreign).
      const scope = { branch: "", space: homeSpace };
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-current",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-behind",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead - 1,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-covered",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead - 1,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-home",
        actionScopeKey: "space",
        rows: [{
          entitySpace: homeSpace,
          entity: "of:f5-home-entity",
          entityScopeKey: "space",
          seq: 1,
        }],
      });

      // Only foreign rows are selected, all of them.
      const foreignRows = selectForeignBasisRows(homeEngine, scope);
      expect(foreignRows.map((row) => row.action).sort()).toEqual([
        "action-behind",
        "action-covered",
        "action-current",
      ]);

      const engineFor = (s: MemorySpace) => server.engineForSpace(s);

      // At-head rows do NOT re-mark; behind rows DO; home-scan-covered
      // rows are not double-added.
      expect(
        await selectForeignStaleInstances(homeEngine, scope, engineFor, [
          { action: "action-covered", actionScopeKey: "space" },
        ]),
      ).toEqual([{ action: "action-behind", actionScopeKey: "space" }]);

      // The foreign head MOVES (bob writes again): the at-head row is
      // now behind and re-marks — the park → foreign-move → reactivate
      // schedule's decision, judged against the foreign engine.
      {
        const tx = bobRuntime.edit();
        doc.withTx(tx).set({ n: 2 });
        expect((await tx.commit()).error).toBeUndefined();
      }
      await bobRuntime.storageManager.synced();
      expect(
        selectDocHead(foreignEngine, { id: docId, scopeKey: "space" }),
      ).toBeGreaterThan(headAtRead);
      expect(
        await selectForeignStaleInstances(homeEngine, scope, engineFor, [
          { action: "action-covered", actionScopeKey: "space" },
        ]),
      ).toEqual([
        { action: "action-behind", actionScopeKey: "space" },
        { action: "action-current", actionScopeKey: "space" },
      ]);
    } finally {
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("a foreign space whose engine cannot resolve fails ONLY its contributions — the home space keeps serving instead of parking (protocol.md §2b; the F1b fix)", async () => {
    // Pre-fix, #resolveForeignEngines was awaited un-caught in the
    // commit step: ONE unresolvable foreign target threw out of the
    // cycle — loop-failed → park + backoff for the whole HOME space,
    // the exact outage class the RULED accumulation refusal exists to
    // prevent. The failure must be action-scoped: the crossing's own
    // contribution withdraws (counted), everything else commits.
    const badSigner = await Identity.fromPassphrase("x-space bad engine");
    const badSpace = badSigner.did() as MemorySpace;
    const proxiedServer = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "engineForSpace") {
          return (s: string) =>
            s === badSpace
              ? Promise.reject(new Error("engine open failed (test)"))
              : target.engineForSpace(s);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryV2Server.Server;

    host = new ExecutorHost({
      server: proxiedServer,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async (space) => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });

    // A served home derivation whose input the client can move — the
    // "everything else" that must keep committing.
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 500) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      const argument = runtime.getCell<{ n: number }>(
        homeSpace,
        "f1b-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        homeSpace,
        "f1b-result",
        compiled.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        const committed = await tx.commit();
        if (committed.error === undefined) break;
        if (attempt >= 4) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.idle();
    };

    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    {
      const tx = clientRuntime.edit();
      clientRuntime.getCell<{ n: number }>(homeSpace, "f1b-arg", undefined, tx)
        .set({ n: 1 });
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
    }
    const clientResult = clientRuntime.getCell<{ total: number }>(
      homeSpace,
      "f1b-result",
      undefined,
    );
    let observed: number | undefined;
    const cancel = clientResult.sink((value) => {
      observed = value?.total;
    });
    try {
      await waitUntil(
        () => observed === 501,
        `first derivation (saw ${observed})`,
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);

      // The misdirected crossing: full §2b carriage, owner-by-identity
      // grant (acting user IS the target space DID, so the accept gate
      // admits without touching the engine) — and the target's engine
      // cannot open.
      const serving = servingRuntime!;
      const badTx = serving.edit();
      stampWaveRunContext(badTx, {
        actionId: "provision-into-bad-space",
        kind: "event-handler",
        eventId: "e-bad-space",
        acting: { user: badSpace, session: "sess-bad" },
        capabilityRef: "cap:test-grant",
      });
      serving.getCell<{ value: number }>(
        badSpace,
        "f1b-bad-doc",
        undefined,
        badTx,
      ).set({ value: 1 });
      const badCommit = await badTx.commit();
      // Accepted into the wave (the gate admits it) — the failure is
      // decided at the commit step's engine resolution.
      expect(badCommit.error).toBeUndefined();

      // The home space must KEEP SERVING: the client moves the input
      // and the served derivation lands in a wave that also had to
      // resolve (and isolate) the bad foreign target.
      {
        const tx = clientRuntime.edit();
        clientRuntime.getCell<{ n: number }>(
          homeSpace,
          "f1b-arg",
          undefined,
          tx,
        ).set({ n: 2 });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      }
      await waitUntil(
        () => observed === 502,
        `re-derivation after the isolated foreign failure (saw ${observed})`,
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);
      await waitUntil(
        () => host!.stats().foreignEngineFailures >= 1,
        "the isolated failure to be counted",
      );
    } finally {
      cancel();
    }
  });

  it("foreignWriteAuthorityFor: the structural grant supply — owner-by-identity, fresh-store creation (non-creating probe), the target's own ACL, fail-closed otherwise (protocol.md §2b; the F1 fix)", async () => {
    const aliceDid = aliceSigner.did();
    const bobDid = bobSigner.did();

    // Owner-by-identity: the target space IS the actor's DID (their
    // home space — the wish bootstrap's sanctioned target).
    expect(
      await server.foreignWriteAuthorityFor(aliceDid, aliceDid),
    ).toEqual({ granted: true, via: "owner" });

    // Creation: a well-formed, never-materialized space is §2b's
    // sanctioned provisioning...
    const freshSigner = await Identity.fromPassphrase(
      "x-space fresh provision target",
    );
    const fresh = freshSigner.did();
    expect(await server.foreignWriteAuthorityFor(fresh, aliceDid)).toEqual({
      granted: true,
      via: "creation",
    });
    // ...and the probe itself must NOT create the store: a second
    // probe still sees a fresh space (had the first probe materialized
    // it, this would now be exists-with-no-ACL → refused).
    expect(await server.foreignWriteAuthorityFor(fresh, bobDid)).toEqual({
      granted: true,
      via: "creation",
    });

    // A malformed space name never resolves (or provisions) a store —
    // the F1c arbitrary-store-creation arm.
    const garbage = await server.foreignWriteAuthorityFor(
      "junk-not-a-space",
      aliceDid,
    );
    expect(garbage.granted).toBe(false);
    // No acting principal: refused outright.
    expect(
      (await server.foreignWriteAuthorityFor(fresh, undefined)).granted,
    ).toBe(false);

    // An EXISTING space with no ACL document fails closed on the
    // serving plane (the client path's populated-legacy compat arm is
    // a rollout accommodation, not a grant).
    await server.engineForSpace(foreignSpace);
    const noAcl = await server.foreignWriteAuthorityFor(
      foreignSpace,
      aliceDid,
    );
    expect(noAcl.granted).toBe(false);

    // The target's OWN ACL document is a real grant: bob grants alice
    // WRITE on bob's space; carol (no row, no wildcard) stays refused.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    try {
      const acl = new ACLManager(bobRuntime, bobDid);
      await acl.set(bobDid, "OWNER");
      await acl.set(aliceDid, "WRITE");
      await bobRuntime.storageManager.synced();
      expect(await server.foreignWriteAuthorityFor(bobDid, aliceDid)).toEqual(
        { granted: true, via: "acl" },
      );
      const carolSigner = await Identity.fromPassphrase("x-space carol");
      const carol = await server.foreignWriteAuthorityFor(
        bobDid,
        carolSigner.did(),
      );
      expect(carol.granted).toBe(false);
    } finally {
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("two demanders on one wish node get their OWN sidecar surfaces — no cross-user mixing (builtins.md §5; the F2 fix)", async () => {
    // The mixed-demand schedule the phase exists to serve: the scheduler
    // runs demanded instances over ONE singular wish node (same Action
    // closure, per-instance stamped txs — scheduler/run.ts), so the
    // builtin's per-node sidecar caches MUST key per demanding identity.
    // Pre-fix, demander #2 reused demander #1's create-surface result
    // cell and clobbered the shared pending input — cross-user mixing in
    // both directions.
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });

    // Seed BOTH users' home spaces: a defaultPattern link with no
    // profiles, so a #profile wish falls to the create surface.
    const seedHome = async (signer: Identity) => {
      const did = signer.did() as MemorySpace;
      const m = SharedServerStorageManager.connectTo(server, { as: signer });
      const r = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: m,
      });
      const tx = r.edit();
      const homeCell = r.getCell(did, did, spaceCellSchema, tx);
      const defaultCell = r.getCell(
        did,
        "x-space-home-default",
        undefined,
        tx,
      );
      (homeCell as Cell<Record<string, unknown>>).key("defaultPattern").set(
        defaultCell as never,
      );
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
      await r.storageManager.synced();
      await r.dispose();
      await m.close();
      return did;
    };
    const aliceDid = await seedHome(aliceSigner);
    const bobDid = await seedHome(bobSigner);

    // Serve the profile-create sidecar SOURCE through a gated fetch stub:
    // the test controls when the (memoized, node-shared) pattern fetch
    // resolves, so both demanders run while the fetch is pending — the
    // exact schedule that clobbered the shared input holder.
    const sidecarSource = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ profiles: unknown }, { echo: unknown }>(",
      "  ({ profiles }) => ({ echo: profiles }),",
      ");",
    ].join("\n");
    const gate = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    const originalEnvironment = getPatternEnvironment();
    setPatternEnvironment({
      apiUrl: new URL("https://x-space-sidecar.test/"),
    });
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/patterns/system/profile-create.tsx")) {
        await gate.promise;
        return new Response(sidecarSource, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cancels: (() => void)[] = [];
    try {
      // Preload the foreign home docs into the serving runtime (wish
      // reads are synchronous; the scheduler's re-trigger is not driven
      // in this direct-drive test).
      for (const did of [aliceDid, bobDid]) {
        const home = serving.getCell(did, did, spaceCellSchema);
        await home.sync();
        await (home as Cell<Record<string, unknown>>).key("defaultPattern")
          .resolveAsCell().sync();
      }

      // The wish node: ONE inputs cell, ONE parent, ONE cause — the
      // singular node — driven directly with per-demander stamped txs.
      const seedTx = serving.edit();
      const inputsCell = serving.getCell<{ query: string }>(
        homeSpace,
        "x-space-wish-inputs",
        undefined,
        seedTx,
      );
      inputsCell.set({ query: "#profile" });
      const parentCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-wish-parent",
        undefined,
        seedTx,
      );
      const causeCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-wish-cause",
        undefined,
        seedTx,
      );
      const seedCommitted = await seedTx.commit();
      expect(seedCommitted.error).toBeUndefined();

      const sent: {
        user: string;
        tx: IExtendedStorageTransaction;
        state: Cell<unknown>;
      }[] = [];
      const action = wishBuiltin(
        inputsCell as never,
        (tx, result) => {
          sent.push({
            user: "pending",
            tx,
            state: result as Cell<unknown>,
          });
        },
        (cancel) => cancels.push(cancel),
        [causeCell as never],
        parentCell as never,
        serving,
      );

      const runAs = async (
        principal: string,
        sessionId: string,
        actionId: string,
      ): Promise<Cell<unknown>> => {
        const tx = serving.edit();
        stampWaveRunContext(tx, {
          actionId,
          kind: "derivation",
          scopeKeyIdentity: { principal, sessionId },
          acting: { user: principal, session: sessionId },
        });
        sent.length = 0;
        action(tx);
        expect(sent.length).toBe(1);
        const state = sent[0].state;
        const sidecar = state.key(UI as never).key("props").key("$cell")
          .resolveAsCell();
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
        return sidecar;
      };

      // Alice's instance runs first (fetch pending), then bob's.
      const aliceSidecar = await runAs(aliceDid, "sess-a", "wish/x-a");
      const bobSidecar = await runAs(bobDid, "sess-b", "wish/x-b");

      // Demander #2 must get their OWN create surface, not demander
      // #1's cell (pre-fix: the closure cache short-circuited on the
      // first demander's cell — bob typed into alice's surface).
      expect(bobSidecar.sourceURI).not.toBe(aliceSidecar.sourceURI);

      // Release the pattern fetch: each pending launch must run ITS OWN
      // demander's input into ITS OWN cell (pre-fix: the shared input
      // holder was clobbered with bob's home link, and alice's pending
      // launch ran bob's input into alice's cell).
      gate.resolve();
      // The landed echo resolves through the run's input `profiles`
      // link into the DEMANDER's home space; before the run lands the
      // key is unset and resolves within the served space.
      const echoSpaceOf = (sidecar: Cell<unknown>): string | undefined => {
        try {
          const echo = (sidecar as Cell<Record<string, unknown>>)
            .key("echo").resolveAsCell();
          const link = echo.getAsNormalizedFullLink();
          return link.space === homeSpace ? undefined : link.space;
        } catch {
          return undefined;
        }
      };
      await waitUntil(
        () =>
          echoSpaceOf(aliceSidecar) !== undefined &&
          echoSpaceOf(bobSidecar) !== undefined,
        `both sidecar runs to land (alice: ${
          echoSpaceOf(aliceSidecar)
        }, bob: ${echoSpaceOf(bobSidecar)})`,
      );
      expect(echoSpaceOf(aliceSidecar)).toBe(aliceDid);
      expect(echoSpaceOf(bobSidecar)).toBe(bobDid);
    } finally {
      gate.resolve();
      globalThis.fetch = originalFetch;
      setPatternEnvironment(originalEnvironment);
      for (const cancel of cancels) cancel();
      await serving.idle();
      await serving.dispose();
      await manager.close();
    }
  });

  it("a serving manager's FOREIGN provider refuses scoped reads fail-closed (protocol.md §2's grant-scoped read design)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    try {
      // Scoped read of a FOREIGN space: refused at the producer, before
      // any wire frame — the unnamed scoped root would resolve against
      // the delegating service envelope (a silently empty instance).
      const foreignScoped = await manager.open(foreignSpace).sync(
        "of:x-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(foreignScoped.error?.message ?? "").toContain(
        "foreign scoped read refused on the serving path",
      );

      // Space-scope foreign reads stay free (§2b's free-read row).
      const foreignSpaceScope = await manager.open(foreignSpace).sync(
        "of:x-plain" as never,
        { path: [], schema: false },
      );
      expect(foreignSpaceScope.error).toBeUndefined();

      // The F3 fix — refusal is ENTRY-scoped, decided at sync() entry
      // before the batch: a scoped read and an innocent SPACE-scope
      // read issued concurrently coalesce into ONE watch-refresh batch
      // with one shared pending promise, and pre-fix the scoped
      // refusal threw over the whole batch — the load-bearing §2b
      // free-read row failed alongside the offender (a persistently
      // retrying scoped reader degraded a space's legitimate foreign
      // reads into flake).
      const provider = manager.open(foreignSpace);
      const [poisoner, innocent] = await Promise.all([
        provider.sync(
          "of:x-batch-scoped" as never,
          { path: [], schema: false },
          "user",
        ),
        provider.sync(
          "of:x-batch-plain" as never,
          { path: [], schema: false },
        ),
      ]);
      expect(poisoner.error?.message ?? "").toContain(
        "foreign scoped read refused on the serving path",
      );
      expect(innocent.error).toBeUndefined();

      // HOME scoped reads keep today's behavior (the OW17 tolerated
      // collapsed view).
      const homeScoped = await manager.open(homeSpace).sync(
        "of:x-home-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(homeScoped.error).toBeUndefined();

      // A NON-serving manager (no servingHomeSpace) is untouched.
      const plain = SharedServerStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      try {
        const clientScoped = await plain.open(foreignSpace).sync(
          "of:x-scoped" as never,
          { path: [], schema: false },
          "user",
        );
        expect(clientScoped.error).toBeUndefined();
      } finally {
        await plain.close();
      }
    } finally {
      await manager.close();
    }
  });
});
