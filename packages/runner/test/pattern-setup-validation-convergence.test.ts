/**
 * Setup validation converges before it judges. A pattern update re-validates
 * the stored argument by materializing it, and what that materialization can
 * see depends on which docs this replica happens to hold — a fact about the
 * moment, not about the data. Convergence arrives in two layers: `runSynced`
 * pre-syncs the argument under the pattern's schema (the server's schema walk
 * delivers the whole linked closure), and the validator itself is tri-state
 * as the backstop — a link target the replica has never pulled yields no
 * verdict at all (a pending postponement, retried on settlement), while a
 * target that is present, or whose ABSENCE the server has confirmed, is
 * judged strictly as the data it is. A refusal is only ever minted over a
 * fully-read value, so it means the data does not conform, never that a doc
 * was late. These cases pin the end-to-end outcomes; which layer converged
 * first is not part of the contract.
 *
 * The production shape behind the never-pulled arm is the 2026-08-21 fleet
 * outage: piece boot delivers docs through meta manifests, whole and
 * untraversed, so a value stored one link-hop past a delivered doc is in NO
 * boot query's closure — the first identity move then re-validated `profiles:
 * 0: name` over that half-replicated graph and bricked every home space. Two
 * sessions against one server reproduce that state honestly: A writes the
 * linked argument, B cold-loads the piece root alone and updates it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  getPatternSetupIdentityRef,
  isStoredArgumentSchemaRefusal,
  isStoredArgumentValidationPending,
} from "../src/index.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("setup-validation-convergence");
const space = signer.did();

const patternWithMarker = (marker: string): string =>
  [
    "import { lift, pattern } from 'commonfabric';",
    "type Entry = { name?: string };",
    "type Input = { registry: Entry[] };",
    "const count = lift<{ registry: Entry[] | undefined }, number>(",
    "  ({ registry }) => (registry ?? []).length,",
    ");",
    "export default pattern<Input, { marker: string; total: number }>(",
    "  ({ registry }) => {",
    `    return { marker: ${
      JSON.stringify(marker)
    }, total: count({ registry }) };`,
    "  },",
    ");",
    "",
  ].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("pattern setup validation convergence", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });
  afterEach(async () => {
    await rtB?.dispose();
    await rtA?.dispose();
    await managerB?.close();
    await managerA?.close();
    await server?.close();
  });

  /** Session A: run V1 with `registry` supplied as a CELL (stored as a link),
   * optionally writing the registry first, then push everything durable. */
  const createInA = async (
    cause: string,
    registryCause: string,
    registryValue: { name?: string }[] | undefined,
  ) => {
    const tx = rtA.edit();
    const registry = rtA.getCell<{ name?: string }[]>(
      space,
      registryCause,
      undefined,
      tx,
    );
    if (registryValue !== undefined) registry.set(registryValue);
    const v1 = await rtA.patternManager.compilePattern(
      programOf(patternWithMarker("v1")),
      { space, tx },
    );
    const cell = rtA.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rtA.run(tx, v1, { registry }, cell);
    const { error } = await tx.commit();
    expect(error?.message).toBeUndefined();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
    await rtA.patternManager.flushCompileCacheWrites();
    await rtA.idle();
    await rtA.storageManager.synced();
    return { registry };
  };

  /** Session B: cold-load the piece root alone, stamp V2, and run the repair
   * (`runSynced` with the pinned identity — the roll-forward materialize). */
  const updateInB = async (cause: string) => {
    const cell = rtB.getCell<Record<string, unknown>>(space, cause);
    await cell.sync();
    const v2 = await rtB.patternManager.compilePattern(
      programOf(patternWithMarker("v2")),
      { space },
    );
    const v2Ref = rtB.patternManager.getArtifactEntryRef(v2)!;
    const { error: stampError } = await rtB.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: v2Ref.identity,
        symbol: v2Ref.symbol,
      });
    });
    expect(stampError?.message).toBeUndefined();
    let error: string | undefined;
    let raised: unknown;
    try {
      await rtB.runSynced(cell, v2, undefined, {
        expectedPatternIdentity: v2Ref,
      });
    } catch (thrown) {
      raised = thrown;
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rtB.idle();
    await rtB.storageManager.synced();
    return { cell, v2, v2Ref, error, thrown: raised };
  };

  it("completes an update whose linked slot exists but was never pulled here", async () => {
    // The outage's precondition, in two real sessions: the registry doc is
    // durable on the server, and session B's replica starts with only what
    // the piece root's meta delivery shipped — the argument doc, not the
    // registry it links. The update must read "[{ name: 'one' }]" before
    // judging — through the pre-sync's schema walk or the validator's own
    // postpone-and-retry — and complete. A validator that judged the cold
    // replica's `undefined` here refused permanently; that verdict class
    // is what bricked every home space on 2026-08-21.
    await createInA(
      "convergence-cold-exists",
      "convergence-cold-exists-registry",
      [{ name: "one" }],
    );

    const { cell, error } = await updateInB("convergence-cold-exists");

    expect(
      error,
      "an update over a link target that exists durably but was not yet " +
        "replicated here was refused — validation judged bytes it never read",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("refuses, classifiably, once the server confirms the linked slot absent", async () => {
    // Same route, but the registry doc was never written anywhere.
    // Convergence delivers the server's word that the doc does not exist,
    // and the judgment lands on a fully-read value: a required array slot
    // holding nothing. That verdict is the refusal — classifiable, so the
    // boot repair escalates instead of retrying — and it is honest: the
    // data, not the replica, fails the schema.
    await createInA(
      "convergence-confirmed-absent",
      "convergence-confirmed-absent-registry",
      undefined,
    );

    const { cell, error, thrown } = await updateInB(
      "convergence-confirmed-absent",
    );

    expect(
      error,
      "an update over a REQUIRED slot whose linked doc the server confirms " +
        "absent must refuse — accepting it would complete a swap over a " +
        "value nobody has",
    ).toContain("updated arguments do not match the candidate schema");
    expect(isStoredArgumentSchemaRefusal(thrown)).toBe(true);
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
  });

  it("completes the held update after the missing data is finally written", async () => {
    // The tail of the refusal case: the verdict was about the data as it
    // stood, so when session A later writes the registry, re-running the
    // same repair in B validates over real bytes and completes the swap.
    // Nothing about the earlier refusal is durable enough to outlive the
    // data that justified it.
    const { registry } = await createInA(
      "convergence-late-write",
      "convergence-late-write-registry",
      undefined,
    );

    const first = await updateInB("convergence-late-write");
    expect(first.error).toContain(
      "updated arguments do not match the candidate schema",
    );

    const tx = rtA.edit();
    registry.withTx(tx).set([{ name: "late" }]);
    const { error: writeError } = await tx.commit();
    expect(writeError?.message).toBeUndefined();
    await rtA.idle();
    await rtA.storageManager.synced();

    let retryError: string | undefined;
    try {
      await rtB.runSynced(first.cell, first.v2, undefined, {
        expectedPatternIdentity: first.v2Ref,
      });
    } catch (thrown) {
      retryError = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rtB.idle();
    expect(
      retryError,
      "the repair did not complete after the registry's first write — a " +
        "refusal outlived the data that justified it",
    ).toBeUndefined();
    await first.cell.pull();
    expect(
      (first.cell.getAsQueryResult() as { marker: string }).marker,
    ).toBe("v2");
  });

  // The pass-over-unread branch, pinned deterministically. `runSynced`'s
  // pre-sync usually converges the closure before validation runs, so these
  // two drive setup through `run()` on an open transaction — no pre-sync —
  // with the readable subset deliberately WARMED (registry synced into B)
  // and one OPTIONAL slot left cold. The readable subset then satisfies the
  // schema outright (an optional slot behind an unloaded link reads as
  // absent), and the verdict must still be a postponement: an acceptance
  // minted there would depend on which docs this replica happened to hold.
  const patternWithNote = (marker: string): string =>
    [
      "import { lift, pattern } from 'commonfabric';",
      "type Entry = { name?: string };",
      "type Input = { registry: Entry[]; note?: string };",
      "const count = lift<{ registry: Entry[] | undefined }, number>(",
      "  ({ registry }) => (registry ?? []).length,",
      ");",
      "export default pattern<Input, { marker: string; total: number }>(",
      "  ({ registry }) => {",
      `    return { marker: ${
        JSON.stringify(marker)
      }, total: count({ registry }) };`,
      "  },",
      ");",
      "",
    ].join("\n");

  /** Session A: run the noted V1 with `registry` warm and `note` linking a
   * doc holding `noteValue`, then push everything durable. */
  const createNotedInA = async (
    cause: string,
    registryCause: string,
    noteCause: string,
    noteValue: unknown,
  ) => {
    const tx = rtA.edit();
    const registry = rtA.getCell<{ name?: string }[]>(
      space,
      registryCause,
      undefined,
      tx,
    );
    registry.set([{ name: "one" }]);
    const note = rtA.getCell<unknown>(space, noteCause, undefined, tx);
    note.set(noteValue);
    const v1 = await rtA.patternManager.compilePattern(
      programOf(patternWithNote("v1")),
      { space, tx },
    );
    const cell = rtA.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rtA.run(tx, v1, { registry, note }, cell);
    const { error } = await tx.commit();
    expect(error?.message).toBeUndefined();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
    await rtA.patternManager.flushCompileCacheWrites();
    await rtA.idle();
    await rtA.storageManager.synced();
  };

  /** Session B: cold root, warm registry, stamp V2, then one setup attempt
   * through `run()` on an open transaction — no pre-sync converges anything
   * on this route, so the `note` doc is provably unread at validation. */
  const setupAttemptInB = async (
    cause: string,
    registryCause: string,
    v2: unknown,
    v2Ref: { identity: string; symbol: string },
  ) => {
    const cell = rtB.getCell<Record<string, unknown>>(space, cause);
    await cell.sync();
    await rtB.getCell<unknown>(space, registryCause).sync();
    const { error: stampError } = await rtB.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: v2Ref.identity,
        symbol: v2Ref.symbol,
      });
    });
    expect(stampError?.message).toBeUndefined();
    return { cell, attempt: () => attemptRun(cell, v2) };
  };

  const attemptRun = async (
    cell: ReturnType<Runtime["getCell"]>,
    v2: unknown,
  ): Promise<unknown> => {
    const tx = rtB.edit();
    try {
      // deno-lint-ignore no-explicit-any
      rtB.run(tx, v2 as any, undefined, cell.withTx(tx));
      const { error } = await tx.commit();
      expect(error?.message).toBeUndefined();
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  };

  it("postpones a setup whose readable subset passes while an optional slot is unread", async () => {
    // The `note` doc holds a perfectly VALID string on the server; B has
    // simply never pulled it. The materialization reads registry (warm),
    // misses note, and the merged value satisfies the schema — the exact
    // shape where an asymmetric check would mint an acceptance over bytes
    // nobody read. The verdict must be the pending postponement, and after
    // one settlement (the miss already kicked the load) the same attempt
    // completes over the full value.
    await createNotedInA(
      "pass-over-unread",
      "pass-over-unread-registry",
      "pass-over-unread-note",
      "fine",
    );
    const v2 = await rtB.patternManager.compilePattern(
      programOf(patternWithNote("v2")),
      { space },
    );
    const v2Ref = rtB.patternManager.getArtifactEntryRef(v2)!;
    const { cell, attempt } = await setupAttemptInB(
      "pass-over-unread",
      "pass-over-unread-registry",
      v2,
      v2Ref,
    );

    const thrown = await attempt();

    expect(
      isStoredArgumentValidationPending(thrown),
      "a validation that passed on its readable subset while an optional " +
        "slot's link target was unread minted a verdict anyway",
    ).toBe(true);
    expect(isStoredArgumentSchemaRefusal(thrown)).toBe(false);

    await rtB.storageManager.synced();
    const retried = await attempt();
    expect(
      retried,
      "the postponed setup did not complete once the unread slot arrived",
    ).toBeUndefined();
    expect(getPatternSetupIdentityRef(cell)?.identity).toBe(v2Ref.identity);
  });

  it("refuses, after convergence, the wrong-typed value the cold pass would have accepted", async () => {
    // The differential that proves the postponement was load-bearing: the
    // same shape, but the unread `note` doc holds a NUMBER where the schema
    // declares an optional string. Cold, the readable subset passes — an
    // asymmetric check would have committed the update over a value the
    // schema rejects. Converged, the value is read and judged: the
    // classifiable refusal, and the completion marker stays on V1.
    await createNotedInA(
      "wrong-typed-unread",
      "wrong-typed-unread-registry",
      "wrong-typed-unread-note",
      7,
    );
    const v2 = await rtB.patternManager.compilePattern(
      programOf(patternWithNote("v2")),
      { space },
    );
    const v2Ref = rtB.patternManager.getArtifactEntryRef(v2)!;
    const { cell, attempt } = await setupAttemptInB(
      "wrong-typed-unread",
      "wrong-typed-unread-registry",
      v2,
      v2Ref,
    );

    const thrown = await attempt();
    expect(isStoredArgumentValidationPending(thrown)).toBe(true);

    await rtB.storageManager.synced();
    const retried = await attempt();
    expect(
      isStoredArgumentSchemaRefusal(retried),
      "a wrong-typed optional slot read after convergence was not refused — " +
        "the cold pass's acceptance leaked through",
    ).toBe(true);
    expect(getPatternSetupIdentityRef(cell)?.identity).not.toBe(
      v2Ref.identity,
    );
  });
});
