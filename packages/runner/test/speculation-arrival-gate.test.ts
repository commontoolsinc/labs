// Server-execution v2 — the client speculation ARRIVAL GATE
// (speculation.md §4, RULED 2026-08-16; landed with fan-out stage A as
// its own commit): an input-origin overlay entry retires on ARRIVAL of
// the authoritative value for every doc instance it wrote — a CONFIRMED
// value at seq ≥ the entry's floor — not on watermark coverage of its
// basis alone. Coverage without arrival is the OW32 retire-to-nothing
// loop: the echo dropped to nothing, the writer (subscribed to its own
// output through the scope-narrowing write path) re-derived,
// re-speculated, retired, forever, on any instance the server never
// served (a per-user node the demand walk did not reach; a served node's
// first wave not yet landed at boot).
//
// - the OW32 shape (the triage's probe): a flag-ON client with NO serving
//   host, a `computed` over a PerUser input (its output scope-narrows
//   into `computed:X/user:<self>`), a watermark that covers the basis
//   with NO store value for the instance → the echo STAYS (bounded runs,
//   entry live, the client value renders, no non-settling episode);
//   mutation (gate removed) → the loop returns;
// - arrival: the store's value for the instance lands at seq ≥ floor,
//   the covering watermark re-sweeps → the entry retires and the store
//   value renders;
// - rider "own retirement is not a trigger": the flip a retiring echo
//   produces carries the echo's own transaction as its source, and the
//   scheduler does not re-dirty that transaction's action for it — a
//   writer subscribed to its own output does not re-derive on a
//   divergent authoritative value, re-speculate, and loop through the
//   gate (mutation: the `integrate` arm of the own-source skip removed →
//   the writer re-dirties);
// - rider "supersede-by-newer" (destination-level, scripted): a newer
//   entry of the same writer whose whole-doc ops cover an older entry's
//   docs retires the older one at seal; a PATCH does not; another writer
//   does not.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  resolveScopeKey,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";

const spaceSigner = await Identity.fromPassphrase("arrival gate space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("arrival gate alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A per-user derivation: `echo` reads a PerUser draft, so its output
 * narrows into the reader's user instance — exactly the shape whose
 * echo the OW32 loop retired to nothing. */
const PER_USER_PATTERN = [
  "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "export default pattern<",
  "  { draft?: PerUser<Draft> },",
  "  { echo: string }",
  ">(({ draft }) => {",
  "  const draftCell: Draft = draft!;",
  "  return {",
  "    echo: computed(() => 'echo:' + ((draftCell.get() as string | undefined) ?? '')),",
  "  };",
  "});",
].join("\n");

describe("speculation arrival gate (speculation.md §4, RULED 2026-08-16)", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const openClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  /** Write the watermark doc from a second session (no serving host in
   * these tests): the client's watermark sink sees `{seq}` and sweeps. */
  const pushWatermark = async (writer: Runtime, seq: number) => {
    const wm = writer.getCellFromLink<{ seq: number }>({
      space,
      id: SERVER_EXECUTION_WATERMARK_DOC_ID as never,
      scope: "space",
      path: [],
    });
    const tx = writer.edit();
    wm.withTx(tx).set({ seq });
    expect((await tx.commit()).error).toBeUndefined();
    await writer.storageManager.synced();
  };

  /** Total runs of the piece's lifts (the per-user `echo` derivation is
   * the only lift): the loop's signature is this count climbing. */
  const echoRunCount = (runtime: Runtime): number =>
    runtime.scheduler.getGraphSnapshot().nodes
      .filter((node) => node.id.includes("cfLift"))
      .reduce((total, node) => total + (node.stats?.runCount ?? 0), 0);

  it("the OW32 shape: a covering watermark with NO store value for the written instance leaves the echo in place — bounded runs, live entry, the client value renders (mutation: gate removed → the retire-to-nothing loop returns); then arrival retires it and the store value renders; own-retirement is not a trigger even when the values diverge", async () => {
    const alice = openClient(aliceSigner);
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PER_USER_PATTERN }],
    }, { space });
    const arg = alice.getCell<Record<string, unknown>>(
      space,
      "ag-arg",
      undefined,
    );
    const result = alice.getCell<{ echo: string }>(
      space,
      "ag-result",
      compiled.resultSchema,
    );
    await arg.sync();
    await result.sync();
    {
      const tx = alice.edit();
      arg.withTx(tx).set({});
      expect((await tx.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, arg, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    // Demand: a live reader.
    const cancelDemand = result.sink(() => {});
    // The per-user input, through the argument schema (narrows into
    // alice's instance).
    const typedArg = alice.getCell<{ draft: string }>(
      space,
      "ag-arg",
      compiled.argumentSchema,
    );
    {
      const tx = alice.edit();
      typedArg.key("draft").withTx(tx).set("A");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    // The ECHO: the client's speculative run rendered it, with NO server.
    await waitUntil(
      () => result.key("echo").get() === "echo:A",
      "the speculative echo to render",
    );
    const overlay = alice.speculationOverlay!;
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    const runsAfterEcho = echoRunCount(alice);

    // A watermark that COVERS the basis (the input's seq and everything
    // before it) — with NO store value for computed:X/user:<alice>.
    const writer = openClient(spaceSigner);
    const coverSeq = Engine.serverSeq(engine);
    await pushWatermark(writer, coverSeq);
    await alice.idle();
    await alice.storageManager.synced();
    // Give a would-be loop time to show itself (pre-fix: ~80 ms cycles,
    // MAX_ITERS per pass, then backoff — dozens of runs in this window).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await alice.idle();

    // THE GATE: the echo stays — the entry is live, the client value
    // renders, and the lift ran a bounded number of times (no
    // retire-to-nothing loop, no non-settling episode).
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    expect(result.key("echo").get()).toBe("echo:A");
    expect(echoRunCount(alice) - runsAfterEcho).toBeLessThanOrEqual(2);
    expect(alice.scheduler.isNonSettling()).toBe(false);
    // And the store still holds nothing for the instance (nobody served
    // it) — the exact OW32 substrate.
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const echoDocs = (engine.database.prepare(
      `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'
       AND id LIKE 'computed:%'`,
    ).all({ scope_key: aliceKey }) as Array<{ id: string }>).map((r) => r.id);
    expect(echoDocs.length).toBe(0);

    // ARRIVAL: the store's value for the instance lands — as a second
    // session of the same principal (the authoritative writer would be
    // the serving loop; its value need not equal the echo), then a
    // covering watermark re-sweeps. Find the echo doc's id from the
    // client's own view of the result.
    const echoLink = result.key("echo").getAsNormalizedFullLink();
    const echoTarget = alice.getCellFromLink<unknown>({
      ...echoLink,
      schema: undefined,
    }).getRaw({ lastNode: "writeRedirect" }) as
      | { "/": { "link@1": { id?: string } } }
      | undefined;
    const echoDocId = echoTarget?.["/"]?.["link@1"]?.id ??
      (() => {
        // The result slot may hold the computed link directly.
        const raw = alice.getCellFromLink<unknown>({
          ...result.getAsNormalizedFullLink(),
          schema: undefined,
        }).getRaw() as { echo?: { "/": { "link@1": { id?: string } } } };
        return raw?.echo?.["/"]?.["link@1"]?.id;
      })();
    expect(echoDocId).toBeDefined();
    const aliceAgain = openClient(aliceSigner);
    const authoritative = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "user",
      path: [],
    });
    const authoritativeSlot = aliceAgain.getCellFromLink<unknown>({
      space,
      id: echoDocId as never,
      scope: "space",
      path: [],
    });
    await authoritative.sync();
    await authoritativeSlot.sync();
    {
      // A DIVERGENT authoritative value: the store says something the
      // echo did not — BOTH docs the speculation wrote (the served
      // narrowing writes exactly these two: the value at the user
      // instance and the redirect at the space slot). The redirect's
      // REPRESENTATION differs from the client's too (an explicit `id`,
      // the shape a served narrowing writes — the triage's §6
      // observation), so the retirement flips the space slot the writer
      // reads: without the own-retirement rider, that flip re-runs the
      // writer, which re-speculates its own shape, which the gate retires
      // at once (the instance HAS arrived), which flips again — forever.
      const tx = aliceAgain.edit();
      authoritative.withTx(tx).set("echo:server" as never);
      authoritativeSlot.withTx(tx).set(
        {
          "/": {
            "link@1": {
              id: echoDocId,
              overwrite: "redirect",
              path: [],
              scope: "user",
            },
          },
        } as never,
      );
      expect((await tx.commit()).error).toBeUndefined();
    }
    await aliceAgain.storageManager.synced();
    const runsBeforeArrival = echoRunCount(alice);
    await pushWatermark(writer, Engine.serverSeq(engine));
    await waitUntil(
      () => overlay.entryCount(space) === 0,
      "the entry to retire on arrival",
    );
    await waitUntil(
      () => result.key("echo").get() === "echo:server",
      "the authoritative value to render",
    );
    await alice.idle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await alice.idle();
    // The flip to the (divergent) authoritative value did not start a
    // re-speculate/re-retire loop: no re-derivation, no live entry, the
    // store value stands. Stated honestly: in THIS fixture the writer's
    // registered reads do not include its own user-instance output (only
    // the space slot's redirect, whose semantic value the arrival did
    // not change), so the divergence loop the own-retirement rider closes
    // is not reachable here — the rider's mechanism is pinned by the
    // next test with its own mutation; this assertion is the end-to-end
    // shape.
    expect(overlay.entryCount(space)).toBe(0);
    expect(echoRunCount(alice) - runsBeforeArrival).toBeLessThanOrEqual(1);
    expect(result.key("echo").get()).toBe("echo:server");
    expect(alice.scheduler.isNonSettling()).toBe(false);
    cancelDemand();
  });

  it("own retirement is not a trigger (mechanism): the flip a superseded speculation produces carries the echo's own transaction as its source, and the scheduler does not re-dirty that transaction's action for it (mutation: no source → the writer re-dirties)", async () => {
    // A flag-ON, non-serving runtime (client posture) on an emulated
    // store: no wave destination — the speculation overlay is the
    // default seal destination, but this pin drives the replica seam
    // directly with a scripted verdict.
    const { StorageManager } = await import(
      "@commonfabric/runner/storage/cache.deno"
    );
    const manager = StorageManager.emulate({ as: aliceSigner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    try {
      const doc = runtime.getCell<{ value: string }>(
        space,
        "own-retirement-doc",
        undefined,
        undefined,
        "user",
      );
      // A LIVE reader of the doc — an effect, so it re-runs on every
      // change to what it read — standing in for the writer subscribed to
      // its own output.
      let runs = 0;
      const writer = (tx: IExtendedStorageTransaction) => {
        runs += 1;
        doc.withTx(tx).get();
      };
      runtime.scheduler.subscribe(writer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.idle();
      expect(runs).toBe(1);

      const replica = manager.open(space).replica;
      const docId = doc.getAsNormalizedFullLink().id;
      const sealSpeculative = (value: string, sourceAction: object) => {
        const sourceTx = runtime.edit();
        sourceTx.tx.sourceAction = sourceAction;
        const { promise, resolve } = Promise.withResolvers<
          { withdrawn: { message: string; superseded: true } }
        >();
        const sealed = replica.sealNative!(
          {
            operations: [{
              op: "set",
              id: docId,
              type: "application/json",
              scope: "user",
              value: { value: { value } } as never,
            }],
            preconditions: [],
          } as never,
          sourceTx.tx,
          promise,
          { speculative: true },
        );
        return {
          retire: async () => {
            resolve({
              withdrawn: { message: "superseded (test)", superseded: true },
            });
            await sealed.settled;
          },
          abort: () => sourceTx.abort(),
        };
      };

      // The writer's OWN echo retires: the flip carries the echo's source,
      // the writer is not re-dirtied.
      const own = sealSpeculative("own-echo", writer);
      await runtime.idle();
      const runsAfterOwnSeal = runs;
      await own.retire();
      await runtime.idle();
      expect(runs).toBe(runsAfterOwnSeal);
      own.abort();

      // A DIFFERENT action's echo retiring on the same doc DOES re-dirty
      // the writer (it is a reader of that doc, not the source).
      const other = () => {};
      const foreign = sealSpeculative("other-echo", other);
      await runtime.idle();
      const runsAfterForeignSeal = runs;
      await foreign.retire();
      await runtime.idle();
      expect(runs).toBeGreaterThan(runsAfterForeignSeal);
      foreign.abort();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });

  it("supersede-by-newer (destination-level): a newer whole-doc entry of the same writer retires the older entry over the same instances at seal; a patch does not; another writer does not", async () => {
    const doc = "of:supersede" as never;
    let nextLocalSeq = 10;
    const replica = {
      sealNative: (
        native: { operations: Array<Record<string, unknown>> },
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        const localSeq = nextLocalSeq++;
        return {
          localSeq,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [] as number[],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
    };
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: () => ({ sink: () => () => {} }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const writerA = { name: "writer-a" };
    const writerB = { name: "writer-b" };
    const seal = (
      writer: object,
      operations: Array<Record<string, unknown>>,
    ) => {
      const tx = {
        tx: {
          sourceAction: writer,
          sealInto: (collector: {
            sealSpaceCommit: (
              space: MemorySpace,
              native: unknown,
              source: unknown,
            ) => Promise<unknown>;
          }) =>
            collector.sealSpaceCommit(
              space,
              { operations, preconditions: [] },
              { sourceAction: writer },
            ).then(() => ({ ok: {} })),
        },
      } as unknown as IExtendedStorageTransaction;
      stampSpeculationRunContext(tx, {
        actionId: "supersede",
        kind: "derivation",
      });
      return destination.seal(tx);
    };
    const set = { op: "set", id: doc, scope: "user", value: { value: 1 } };
    const patch = {
      op: "patch",
      id: doc,
      scope: "user",
      patches: [{ op: "replace", path: "/value", value: 2 }],
    };
    // Entry 1 (A, set) then entry 2 (A, set over the same instance): 1
    // is superseded at 2's seal.
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // Entry 3 (A, PATCH): the older whole-doc entry is KEPT (the patch is
    // path-relative to the layer beneath it).
    expect((await seal(writerA, [patch])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(2);
    // Entry 4 (B, set): another writer never supersedes A's entries.
    expect((await seal(writerB, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(3);
    // Entry 5 (A, set) supersedes A's set-entry (2) — but NOT the patch
    // entry (3): a patch's docs are covered by a whole-doc set... entry 3
    // wrote `doc` too, by patch; the newer set covers its DOC, so it is
    // superseded (dropping a patch layer under a whole-doc set is
    // invisible); B's entry stays.
    expect((await seal(writerA, [set])).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(2);
    destination.close();
  });
});
