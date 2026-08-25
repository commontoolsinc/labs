/**
 * CT-1917 (2026-07-28 estuary): a hot-swap to a new pattern version re-runs
 * setup, and setup re-validates the STORED argument against the candidate
 * schema by materializing it — dereferencing every link. What that validation
 * may conclude about a link-valued slot is tri-state, and this file pins the
 * line: a target the replica has never pulled is NOT judged (the swap
 * postpones and retries on convergence — the two-session cases cover that
 * shape); a target the replica holds, or holds the CONFIRMED ABSENCE of, is
 * judged as the data it is — so a required slot over a confirmed-absent doc
 * holds the swap, V1 keeps running, and the first write that materializes
 * the doc re-fires the watcher and completes it. No verdict is ever minted
 * over bytes nobody read; no data that was read escapes its verdict.
 *
 * Production shape (the original incident): BacklinksIndex's `pieceRegistry`
 * argument links into its host default-app's registry cell; the host was down
 * (its own pattern failed to compile), the link read cold, and the
 * official-pattern upgrade of BacklinksIndex died on "missing required
 * property pieceRegistry".
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("pattern-swap-link-argument");
const space = signer.did();

// V1/V2 share the argument schema — `registry` is a required array slot —
// and differ only in a result marker so the running version is observable.
// The lift tolerates an unreadable registry the way real index patterns do.
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

describe("pattern swap with a link-valued argument slot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  // Start V1 with `registry` supplied as a CELL (stored as a link), then move
  // patternIdentity to V2 so the armed watcher performs the hot-swap.
  const startThenSwap = async (
    registryCell: unknown,
  ): Promise<{
    cell: ReturnType<Runtime["getCell"]>;
    v2Identity: string;
  }> => {
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(patternWithMarker("v1")), {
      space,
      tx,
    });
    const v2 = await pm.compilePattern(programOf(patternWithMarker("v2")), {
      space,
      tx,
    });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-piece",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { registry: registryCell }, cell);
    await tx.commit();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");

    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    });
    await tx2.commit();
    await rt.idle();
    await cell.pull();
    return { cell, v2Identity: v2Ref.identity };
  };

  it("swaps when the linked registry doc has data (warm control)", async () => {
    const tx = rt.edit();
    const registry = rt.getCell<{ name?: string }[]>(
      space,
      "swap-link-argument-registry-warm",
      undefined,
      tx,
    );
    registry.set([{ name: "one" }]);
    await tx.commit();

    const { cell } = await startThenSwap(registry);
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("holds the swap while a REQUIRED linked slot is confirmed absent", async () => {
    // Never written anywhere, and this single-store session has synced: the
    // replica does not MISS the registry doc, it holds the server's word that
    // the doc is absent. That is a judged read, not an unconverged one, so
    // strict validation refuses the swap over it — `registry` is required —
    // and the piece keeps running V1 with its stored argument untouched. The
    // refusal is a verdict about the data as it stands, not a permanent
    // sentence on the piece: the recovery — the next cold load's repair
    // completing the swap once a write materializes the registry — is pinned
    // in pattern-setup-validation-convergence.test.ts, whose shared-server
    // harness can cold-start a second session; a target that is merely
    // UNLOADED (rather than confirmed absent) postpones instead of refusing,
    // pinned there too.
    const registry = rt.getCell<{ name?: string }[]>(
      space,
      "swap-link-argument-registry-absent",
    );

    const { cell } = await startThenSwap(registry);
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "a swap committed over a required slot whose linked doc is confirmed " +
        "absent — validation judged bytes nobody read",
    ).toBe("v1");
  });

  it("holds the swap while an ITEM-level linked slot is confirmed absent", async () => {
    // Links live at any depth: an array slot whose ITEM links to a confirmed
    // absent doc gets the same verdict as a link at the slot itself — the
    // item reads as a judged absence against the required item type, so the
    // swap holds and V1 keeps running.
    const entry = rt.getCell<{ name?: string }>(
      space,
      "swap-link-argument-array-item-absent",
    );

    const { cell } = await startThenSwap([entry]);
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");
  });

  it("swaps when the argument doc itself reads cold (nested-piece shape)", async () => {
    // A nested piece's argument meta links into its HOST's doc; when the host
    // is down that whole doc reads cold. Production signature: "missing
    // required property pieceRegistry" — validation ran against bare defaults
    // after the argument link dereferenced to nothing.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(patternWithMarker("v1")), {
      space,
      tx,
    });
    const v2 = await pm.compilePattern(programOf(patternWithMarker("v2")), {
      space,
      tx,
    });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-piece-cold-doc",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { registry: [{ name: "one" }] }, cell);
    await tx.commit();
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");

    // Retarget the argument meta at a doc that was never written — the swap
    // must not treat "argument unreadable right now" as "argument invalid".
    const coldArgument = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-cold-argument-doc",
    );
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw(
      "argument",
      coldArgument.getAsWriteRedirectLink({ base: cell }),
    );
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    });
    await tx2.commit();
    await rt.idle();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });
});
