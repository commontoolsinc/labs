// Server-execution v2 stage P2-F: the per-(action × instance) run
// SUPPLY and its two classification consequences, pinned at the unit
// level (the serving-loop E2E drives the same machinery through the
// production demand registry):
//
// - the N-run settle loop: a scheduler action whose piece root has
//   demanded instances runs ONCE PER INSTANCE, each run's transaction
//   stamped with that instance's identity through the production
//   choke point (run.ts → stampServerRun → the installed stamper) —
//   instances live in keys/basis/stamps, never as extra graph nodes;
// - the LT6 inheritance rule (events.md §2, RULED 2026-08-03): an
//   event emitted by a stamped run hands its acting identity to the
//   dispatched handler run — a cascade rooted in a demanded
//   (user, session) derivation preserves the actor hop by hop instead
//   of blanking to the userless service fallback;
// - the F1 fold-in (RULED 2026-08-13, option c): a piece-start setup
//   commit that fails on the serving runtime surfaces loudly through
//   `Runtime.pieceStartCommitFailureObserver` instead of being
//   swallowed by the fire-and-forget start path (the piece silently
//   running against stale setup was the filed hazard).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import { stampWaveRunContext, waveRunContextOf } from "../src/executor/wave.ts";
import type {
  IExtendedStorageTransaction,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("p2f run supply");
const space = signer.did();

const alice = {
  principal: "did:key:p2f-alice",
  sessionId: "alice-s1" as never,
};
const bob = { principal: "did:key:p2f-bob", sessionId: "bob-s1" as never };

describe("stage P2-F per-(action × instance) run supply", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  /** Every ServerRunInfo the production stamping choke points hand the
   * installed stamper, in order. */
  let stamped: ServerRunInfo[];

  /** A PASS-THROUGH destination: seals commit natively (byte-identical
   * to no destination) while the installed stamper records and stamps
   * every run context — the unit-level stand-in for the SpaceServer's
   * stamper seam. */
  const passThroughDestination = (): TransactionSealDestination => ({
    seal: (tx: IExtendedStorageTransaction) => tx.tx.commit(),
  });

  const recordingStamper = (
    tx: IExtendedStorageTransaction,
    info: ServerRunInfo,
  ): void => {
    stamped.push(info);
    stampWaveRunContext(tx, {
      actionId: info.actionId,
      kind: info.kind,
      ...(info.eventId !== undefined ? { eventId: info.eventId } : {}),
      ...(info.scopeKeyIdentity !== undefined
        ? { scopeKeyIdentity: info.scopeKeyIdentity }
        : {}),
      ...(info.actionScopeKey !== undefined
        ? { actionScopeKey: info.actionScopeKey }
        : {}),
    });
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    stamped = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await storageManager.close();
  });

  it("runs a demanded action once per instance, stamping each run with that instance's identity (the N-run settle loop)", async () => {
    const rootId = "of:p2f-fanout-root";
    const aliceKey = resolveScopeKey("user", alice);
    const bobKey = resolveScopeKey("user", bob);
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runInstanceResolver: (pieceRootId) =>
        pieceRootId === rootId
          ? [
            { scopeKeyIdentity: alice, actionScopeKey: aliceKey },
            { scopeKeyIdentity: bob, actionScopeKey: bobKey },
          ]
          : [],
    });

    const observedContexts: Array<
      { actionScopeKey?: string; principal?: string } | undefined
    > = [];
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(tx);
        observedContexts.push(
          context === undefined ? undefined : {
            actionScopeKey: context.actionScopeKey,
            principal: context.scopeKeyIdentity?.principal,
          },
        );
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );

    await runtime.scheduler.run(action);
    await runtime.idle();

    // TWO runs — one per demanded instance, in registry order — each
    // stamped through the PRODUCTION choke point with its instance's
    // identity, and each run's transaction carrying that context.
    const derivationStamps = stamped.filter((info) =>
      info.kind === "derivation"
    );
    expect(derivationStamps.length).toBe(2);
    expect(derivationStamps[0].scopeKeyIdentity?.principal).toBe(
      alice.principal,
    );
    expect(derivationStamps[0].actionScopeKey).toBe(aliceKey);
    expect(derivationStamps[1].scopeKeyIdentity?.principal).toBe(
      bob.principal,
    );
    expect(derivationStamps[1].actionScopeKey).toBe(bobKey);
    expect(observedContexts).toEqual([
      { actionScopeKey: aliceKey, principal: alice.principal },
      { actionScopeKey: bobKey, principal: bob.principal },
    ]);
  });

  it("keeps the single wave-identity run for an action with no demanded instances", async () => {
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
      runInstanceResolver: () => [],
    });
    let invocations = 0;
    const action = Object.assign(
      (_tx: IExtendedStorageTransaction) => {
        invocations += 1;
      },
      {
        schedulerObservationIdentity: {
          pieceId: "space:of:p2f-solo-root",
          pieceRootId: "of:p2f-solo-root",
        },
      },
    );
    await runtime.scheduler.run(action);
    await runtime.idle();
    expect(invocations).toBe(1);
    const derivationStamps = stamped.filter((info) =>
      info.kind === "derivation"
    );
    expect(derivationStamps.length).toBe(1);
    expect(derivationStamps[0].scopeKeyIdentity).toBeUndefined();
  });

  it("hands the emitting run's identity to the dispatched handler run (LT6: events run as the session they originated from)", async () => {
    const aliceKey = resolveScopeKey("user", alice);
    runtime.installSealDestination(passThroughDestination(), {
      runStamper: recordingStamper,
    });

    // A handler on a stream doc, registered directly (events.md §1's
    // `addSchedulerEventHandler` hook).
    const streamCell = runtime.getCell<{ v?: number }>(
      space,
      "p2f-lt6-stream",
      undefined,
    );
    await streamCell.sync();
    const streamLink = streamCell.getAsNormalizedFullLink();
    const handled = Promise.withResolvers<void>();
    const cancel = runtime.scheduler.addEventHandler(
      (_tx, _event) => {
        handled.resolve();
      },
      streamLink,
    );

    try {
      // The EMITTING run: a demanded user-session derivation — its tx
      // stamped through the production choke point with the demand's
      // identity (the run supply's output), committed like a finished
      // run (the production `Cell.send` path forwards the run's own
      // `this.tx` the same way; the stamp side-table survives commit).
      const originTx = runtime.edit();
      runtime.stampServerRun(originTx, {
        actionId: "test/p2f-emitting-derivation",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: aliceKey,
      });
      const originProbe = runtime.getCell<{ emitted?: boolean }>(
        space,
        "p2f-lt6-origin-probe",
        undefined,
      );
      await originProbe.sync();
      originProbe.withTx(originTx).set({ emitted: true });
      runtime.scheduler.queueEvent(
        streamLink,
        { v: 1 },
        true,
        undefined,
        true,
        { originTx },
      );
      expect((await originTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await handled.promise;

      // The dispatched handler run's stamp INHERITS the emitting run's
      // acting identity (LT6) — pre-P2-F it carried none and the
      // handler classified userless.
      const handlerStamps = stamped.filter((info) =>
        info.kind === "event-handler"
      );
      expect(handlerStamps.length).toBeGreaterThanOrEqual(1);
      expect(handlerStamps[0].scopeKeyIdentity?.principal).toBe(
        alice.principal,
      );
      expect(String(handlerStamps[0].scopeKeyIdentity?.sessionId)).toBe(
        "alice-s1",
      );
      expect(handlerStamps[0].actionScopeKey).toBe(aliceKey);
    } finally {
      cancel();
    }
  });
});

// ---------------------------------------------------------------------------
// F1 (RULED 2026-08-13, option c): the piece-start setup commit's
// failure must SURFACE — loudly, counted — never be swallowed by the
// fire-and-forget start path.
// ---------------------------------------------------------------------------

const V1_NO_HANDLER = [
  "import { Writable, pattern } from 'commonfabric';",
  "interface Args { [key: string]: any }",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

const V3_WITH_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "interface Args { limit?: number; [key: string]: any }",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Args, { count: Writable<number> }>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("stage P2-F piece-start commit failure surfacing (F1)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: {
        serverExecution: true,
        systemPatternAutoUpdate: true,
      },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // The bricked-piece fixture (nested-piece-setup-repair.test.ts's
  // shape): set up for V1, then re-point patternIdentity at the
  // handler-bearing V3 whose stream marker the V1 doc never
  // materialized — the exact durable state whose demanded start mints
  // a setup-REPAIR write on the serving runtime (`ensurePieceRunning`
  // → start → startCore → applySetupState).
  const brickedPiece = async () => {
    const tx = runtime.edit();
    const pm = runtime.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), {
      space,
      tx,
    });
    const v3 = await pm.compilePattern(programOf(V3_WITH_HANDLER), {
      space,
      tx,
    });
    const v3Ref = pm.getArtifactEntryRef(v3)!;
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "p2f-f1-brick",
      undefined,
      tx,
    );
    const running = runtime.runner.run(tx, v1, { limit: 3 }, cell);
    await tx.commit();
    await running.pull();
    runtime.runner.stop(cell);
    const tx2 = runtime.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v3Ref.identity,
      symbol: v3Ref.symbol,
    });
    await tx2.commit();
    return cell;
  };

  it("surfaces a refused piece-start setup-repair commit through the observer instead of swallowing it", async () => {
    const cell = await brickedPiece();

    // A destination that REFUSES exactly the piece-start repair's
    // sealed commit and passes everything else through natively — the
    // deterministic stand-in for a wave-side refusal (a conflict drop,
    // a lease-lost withdrawal, the §3d refusal of an unstamped tx).
    const refused: string[] = [];
    runtime.installSealDestination({
      seal: (tx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(tx);
        if (context?.actionId.startsWith("piece-start-repair/")) {
          refused.push(context.actionId);
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "test refusal of the piece-start repair seal",
              reason: new Error("p2f-f1-test-refusal"),
            },
          });
        }
        return tx.tx.commit();
      },
    }, {
      runStamper: (tx, info) => {
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
        });
      },
    });

    const surfaced: Array<{ actionId: string; error: unknown }> = [];
    runtime.pieceStartCommitFailureObserver = (failure) => {
      surfaced.push(failure);
    };

    // The demanded start: instantiation throws missing-stream-marker,
    // the repair stages setup + retries in one tx, and THAT commit is
    // refused at the seal. Pre-F1 the refusal Result was swallowed
    // (teardown only, no surfacing) — the piece silently ran against
    // stale setup with nothing counted anywhere.
    await runtime.start(cell);
    await runtime.idle();

    // The refusal genuinely happened…
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // …and SURFACED: the observer received the failure, action-id
    // attributed (the loud log rides the same call).
    expect(surfaced.length).toBeGreaterThanOrEqual(1);
    expect(surfaced[0].actionId.startsWith("piece-start-repair/")).toBe(true);
    runtime.clearSealDestination();
  });

  it("surfaces a refused fire-and-forget piece-INSTANTIATE commit through the observer (the start path's own arm, not only the repair's)", async () => {
    // A HEALTHY piece — no repair involved: run V1, stop, restart. The
    // restart's startCore mints the self-minted fire-and-forget
    // instantiation tx (`piece-instantiate/<root>`) — the arm the F1
    // hazard was actually filed about (start() resolves before the
    // commit settles, so a swallowed refusal leaves the piece silently
    // running against writes that never landed).
    const tx = runtime.edit();
    const pm = runtime.patternManager;
    const v1 = await pm.compilePattern(programOf(V1_NO_HANDLER), {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "p2f-f2-restart",
      undefined,
      tx,
    );
    const running = runtime.runner.run(tx, v1, { limit: 3 }, cell);
    await tx.commit();
    await running.pull();
    runtime.runner.stop(cell);

    // A destination that REFUSES exactly the instantiate seal and
    // passes everything else through natively — the same deterministic
    // wave-side refusal stand-in as the repair test above.
    const refused: string[] = [];
    runtime.installSealDestination({
      seal: (sealTx: IExtendedStorageTransaction) => {
        const context = waveRunContextOf(sealTx);
        if (context?.actionId.startsWith("piece-instantiate/")) {
          refused.push(context.actionId);
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "test refusal of the piece-instantiate seal",
              reason: new Error("p2f-f2-test-refusal"),
            },
          });
        }
        return sealTx.tx.commit();
      },
    }, {
      runStamper: (stampTx, info) => {
        stampWaveRunContext(stampTx, {
          actionId: info.actionId,
          kind: info.kind,
        });
      },
    });

    const surfaced: Array<{ actionId: string; error: unknown }> = [];
    runtime.pieceStartCommitFailureObserver = (failure) => {
      surfaced.push(failure);
    };

    // Fire-and-forget by design: start resolves true while the refused
    // commit settles behind it.
    const started = await runtime.start(cell);
    expect(started).toBe(true);
    await runtime.idle();

    // The refusal genuinely happened…
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // …and SURFACED through the observer (neutralization red: silence
    // the instantiate arm's commit().then/.catch reporting in
    // instantiatePattern and this never fires).
    const deadline = Date.now() + 5_000;
    while (surfaced.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(surfaced.length).toBeGreaterThanOrEqual(1);
    expect(surfaced[0].actionId.startsWith("piece-instantiate/")).toBe(true);
    runtime.clearSealDestination();
  });

  it("stamps the piece-start repair seal with the sanctioned bookkeeping kind (the §3d piece-start site, RULED 2026-08-13)", async () => {
    const cell = await brickedPiece();
    const stamps: ServerRunInfo[] = [];
    runtime.installSealDestination({
      seal: (tx: IExtendedStorageTransaction) => tx.tx.commit(),
    }, {
      runStamper: (tx, info) => {
        stamps.push(info);
        stampWaveRunContext(tx, { actionId: info.actionId, kind: info.kind });
      },
    });
    const started = await runtime.start(cell);
    expect(started).toBe(true);
    await runtime.idle();
    const repairStamps = stamps.filter((info) =>
      info.actionId.startsWith("piece-start-repair/")
    );
    expect(repairStamps.length).toBeGreaterThanOrEqual(1);
    expect(repairStamps[0].kind).toBe("bookkeeping");
    runtime.clearSealDestination();
  });
});
