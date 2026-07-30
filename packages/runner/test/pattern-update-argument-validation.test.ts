import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink } from "../src/link-utils.ts";

// A pattern update must not leave durable state the new version's argument
// schema cannot read. `packages/piece/src/schema-compatibility.ts` waives one
// class on exactly that ground: over an OPEN argument object a candidate may
// name a brand-new optional field of any type, because the runner "validates
// the piece's merged durable arguments against the new schema transactionally
// before committing such an update". These cases are what makes that true.
//
// Both production update routes are covered, because they reach setup
// differently and only one of them ever validated:
//
// - HOT-SWAP: the `patternIdentity` watcher on a RUNNING piece calls
//   `applySetupState` with `sameStoredSetup = false`, so the stored argument is
//   re-staged and validated.
// - ROLL-FORWARD MATERIALIZE (`pieces-controller.ts`): the candidate's identity
//   is committed onto the root FIRST, then setup runs. The pointer then already
//   names the candidate, so a pointer-only comparison reports "same pattern"
//   and the re-stage — with its validation — was skipped. The completion marker
//   `patternSetupIdentity` is what tells the two apart: it names the version
//   that actually staged the stored argument. The same shape reaches setup
//   through `pieces-controller.ts`'s cold-start repair, whose root had its
//   pointer moved with no setup at all by `PatternUpdater`'s instantiated mode.
//
// A caller that hands setup a pattern the pointer does not name yet — the
// default-root apply, `cf piece setsrc` — was recognized as a change already
// and needed nothing here.
//
// The cold-link cases are the CT-1917 counterweight and belong in the same
// file: this validation only stays correct while "a slot I cannot read right
// now" keeps being distinguished from "a slot holding a plain value of the
// wrong type". Tightening one of these breaks the other, so a reader changing
// either sees both. `pattern-swap-link-argument.test.ts` covers the same
// deferral on the swap route in production shape.

const signer = await Identity.fromPassphrase("pattern-update-argument-check");
const space = signer.did();

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

/**
 * A version whose argument object is OPEN, so it stores `count` under any type
 * legally. `marker` makes the running version observable.
 *
 * `[key: string]: any` is what produces `additionalProperties: true`.
 * `Record<string, unknown>` does not: `unknown` maps to `{type:"unknown"}`.
 */
const openArgument = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface Args { [key: string]: any }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

/** The candidate: same open object, but `count` is now a typed named field. */
const typedCount = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface Args { count?: number; [key: string]: any }",
    "export default pattern<Args, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "",
  ].join("\n"));

describe("pattern update validates the stored argument", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  /**
   * Set up `vintage` on a fresh root with `argument` stored durably, WITHOUT
   * starting it — the cold root a repair path finds. Not starting is what keeps
   * this on the roll-forward route: `start()` arms the `patternIdentity`
   * watcher, and any later stamp would then be serviced by the hot-swap instead.
   */
  const setupVintage = async (
    vintage: RuntimeProgram,
    argument: unknown,
    cause: string,
  ) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(vintage, {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    await rt.setup(tx, pattern, argument, cell);
    await tx.commit();
    await rt.idle();
    return cell;
  };

  /** Stamp `ref` and materialize `candidate`, the production repair shape. */
  const rollForward = async (
    cell: Awaited<ReturnType<typeof setupVintage>>,
    candidate: RuntimeProgram,
  ): Promise<{ error?: string }> => {
    const pattern = await rt.patternManager.compilePattern(candidate, {
      space,
    });
    const ref = rt.patternManager.getArtifactEntryRef(pattern)!;
    const { error: stampError } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: ref.identity,
        symbol: ref.symbol,
      });
    });
    expect(stampError?.message).toBeUndefined();
    let error: string | undefined;
    try {
      // `expectedPatternIdentity` is what makes a rejected setup commit THROW
      // rather than log and continue — the same reason the repair passes it.
      await rt.runSynced(cell.withTx(), pattern, undefined, {
        expectedPatternIdentity: ref,
      });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    // Settle either outcome before returning. A refused setup rejects out of
    // `runSynced` with the dependency loads it started still in flight, and
    // tearing the runtime down under them logs a spurious sync failure against
    // a closed replica — noise that reads like a defect in the case that just
    // passed.
    await rt.idle();
    await rt.storageManager.synced();
    return { error };
  };

  it("refuses a roll-forward whose stored argument the candidate rejects", async () => {
    // `count: "seven"` was legal under the open object and is not a number.
    const cell = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "roll-forward-wrong-type",
    );

    const { error } = await rollForward(cell, typedCount("v2"));

    // Assert the SPECIFIC refusal. A bare `toBeDefined()` would also pass on a
    // compile error, a missing store, or a disposed runtime — green for the
    // wrong reason on the one case this file exists for.
    expect(
      error,
      "the roll-forward materialize accepted a durable argument the candidate " +
        "schema cannot read. `schema-compatibility.ts` waives the open-argument " +
        "evolution class on the promise that this path validates it",
    ).toContain("updated arguments do not match the candidate schema");
    expect(error).toContain("count: value does not match type number");

    // The bytes are untouched: a refusal must abort the transaction, not
    // half-apply it. Reading them back is what tells "refused" from "deleted".
    const link = getMetaLink(cell, "argument")!;
    expect(
      rt.getCellFromLink(link).getRaw(),
      "the refusal did not leave the stored argument intact",
    ).toEqual({ count: "seven" });
  });

  it("rolls a COMPATIBLE stored argument forward (control)", async () => {
    // The control this file is unsound without: if a roll-forward refused every
    // argument, the case above would pass while proving nothing about types.
    const cell = await setupVintage(
      openArgument("v1"),
      { count: 7 },
      "roll-forward-right-type",
    );

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(error).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
    expect(rt.getCellFromLink(getMetaLink(cell, "argument")!).getRaw()).toEqual(
      {
        count: 7,
      },
    );
  });

  it("rolls forward when a stored slot holds a link that reads COLD", async () => {
    // CT-1917 on the roll-forward route, and the differential that pins WHERE
    // the line falls: same candidate as the refusal case above, same slot, same
    // schema — the only difference is that `count` holds a LINK rather than a
    // plain value. A link to a doc that is absent (or simply not loaded this
    // session, the ordinary client cold state) must not read as "invalid", or
    // every not-yet-synced nested argument becomes a failed update; the
    // vintage's own instantiation wrote exactly this link. Refuse the plain
    // value, defer the unreadable link.
    const absent = rt.getCell<number>(space, "roll-forward-cold-target");
    const cell = await setupVintage(
      openArgument("v1"),
      { count: absent },
      "roll-forward-cold-link",
    );

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(
      error,
      "an argument slot whose link cannot be dereferenced right now was " +
        "treated as invalid, which would fail every update over a doc that " +
        "has not synced (CT-1917)",
    ).toBeUndefined();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("leaves a same-version setup alone, even over a mismatched argument", async () => {
    // The blast-radius guard, and the reason this check keys on the setup
    // marker rather than on strictness everywhere. A stored argument can fail
    // its OWN pattern's schema — written before a field was typed, or by a
    // schema-less write — and re-running setup for the SAME version must not
    // start refusing it. Widen the condition and every such piece stops
    // starting at boot instead of at the update that introduced the mismatch.
    const cell = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "same-version-mismatch",
    );

    const pattern = await rt.patternManager.compilePattern(openArgument("v1"), {
      space,
    });
    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), pattern, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();

    expect(
      error,
      "re-running setup for the SAME version refused an argument that version " +
        "itself stored, which turns a pre-existing mismatch into a piece that " +
        "will not boot",
    ).toBeUndefined();
    expect(rt.getCellFromLink(getMetaLink(cell, "argument")!).getRaw()).toEqual(
      {
        count: "seven",
      },
    );
  });

  it("refuses a HOT-SWAP whose stored argument the candidate rejects", async () => {
    // The other route, on a RUNNING piece: the `patternIdentity` watcher
    // services the stamp. This one already validated; it is here so the two
    // routes cannot drift apart silently.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(openArgument("v1"), { space, tx });
    const v2 = await pm.compilePattern(typedCount("v2"), { space, tx });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "hot-swap-wrong-type",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
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

    // A failed swap setup is logged, not thrown — `runSynced` is not in this
    // path — so the running version is the observable: the piece stays on V1
    // rather than running V2 over state V2 cannot read.
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "the hot-swap accepted a durable argument the candidate schema rejects",
    ).toBe("v1");
  });
});
