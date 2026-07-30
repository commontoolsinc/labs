import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  isStoredArgumentSchemaRefusal,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
} from "../src/index.ts";
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
    return {
      cell,
      identity: rt.patternManager.getArtifactEntryRef(pattern)!.identity,
    };
  };

  /** Stamp `ref` and materialize `candidate`, the production repair shape. */
  const rollForward = async (
    cell: Cell<Record<string, unknown>>,
    candidate: RuntimeProgram,
  ): Promise<{ error?: string; thrown?: unknown; identity: string }> => {
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
    let raised: unknown;
    try {
      // `expectedPatternIdentity` is what makes a rejected setup commit THROW
      // rather than log and continue — the same reason the repair passes it.
      await rt.runSynced(cell.withTx(), pattern, undefined, {
        expectedPatternIdentity: ref,
      });
    } catch (thrown) {
      raised = thrown;
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    // Settle either outcome before returning. A refused setup rejects out of
    // `runSynced` with the dependency loads it started still in flight, and
    // tearing the runtime down under them logs a spurious sync failure against
    // a closed replica — noise that reads like a defect in the case that just
    // passed.
    await rt.idle();
    await rt.storageManager.synced();
    return { error, thrown: raised, identity: ref.identity };
  };

  it("refuses a roll-forward whose stored argument the candidate rejects", async () => {
    // `count: "seven"` was legal under the open object and is not a number.
    const { cell, identity: vintageIdentity } = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "roll-forward-wrong-type",
    );

    const { error, thrown, identity: rejectedIdentity } = await rollForward(
      cell,
      typedCount("v2"),
    );

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

    // The refusal must be CLASSIFIABLE, not just readable. A boot repair keys
    // its recovery on this: re-running the same identity refuses identically,
    // so `PiecesController` escalates to the roll-forward backstop instead of
    // retrying, and a failure it cannot classify is discarded in favour of the
    // original start error. Assert against the error the runner ACTUALLY threw
    // rather than a hand-written string, so the thrower and the classifier
    // cannot drift apart.
    expect(
      isStoredArgumentSchemaRefusal(thrown),
      "the refusal is no longer classifiable, so a boot repair will discard " +
        "it and surface an unrelated start error instead of escalating",
    ).toBe(true);

    // The bytes are untouched: a refusal must abort the transaction, not
    // half-apply it. Reading them back is what tells "refused" from "deleted".
    const link = getMetaLink(cell, "argument")!;
    expect(
      rt.getCellFromLink(link).getRaw(),
      "the refusal did not leave the stored argument intact",
    ).toEqual({ count: "seven" });

    // What a refusal does NOT undo, asserted so it is a documented consequence
    // rather than a surprise. The identity stamp and the materialize are
    // separate transactions — the repair commits the pointer first, on purpose,
    // so the swap can carry its own precondition — and only the second one
    // aborts here. The durable root is therefore left NAMING the rejected
    // candidate while its setup marker still names the version that staged the
    // state, which is exactly the shape a CFC migration refusal already
    // produces on this path. The next boot re-attempts the repair and refuses
    // again, loudly, until the incompatible argument or pattern is fixed;
    // silently running the candidate over state it cannot read is the outcome
    // this whole gate exists to prevent.
    await cell.sync();
    expect(
      getPatternIdentityRef(cell as Cell<unknown>)?.identity,
      "a refused roll-forward rolled the pointer back. That is a deliberate " +
        "behaviour change, not a cleanup: the repair reaches this path BECAUSE " +
        "the previously pinned pattern could not be set up either",
    ).toBe(rejectedIdentity);
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>)?.identity,
      "the refused setup stamped its completion marker, so a later boot would " +
        "read the root as fully staged for a version that never staged it",
    ).toBe(vintageIdentity);
  });

  it("lets a MARKERLESS root through, and marks it on the way", async () => {
    // The deliberate exemption, pinned so it is a decision rather than an
    // assumption. `stagedByOtherVersion` treats an absent `patternSetupIdentity`
    // as "same": absence cannot be told from a pending update, and re-staging
    // every such root would validate — and rewrite defaults over — arguments no
    // update is touching.
    //
    // Nothing else covers this population. Tier 2's vintage replay cannot: its
    // captures run setup through the current runner, which always stamps the
    // marker, so a captured root is never markerless. Hence this case, which
    // strips the marker to reach the state a root written before the marker
    // existed is in.
    const { cell } = await setupVintage(
      openArgument("v1"),
      { count: "seven" },
      "markerless-root",
    );
    const { error: stripError } = await rt.editWithRetry((tx) => {
      cell.withTx(tx).setMetaRaw("patternSetupIdentity", undefined);
    });
    expect(stripError?.message).toBeUndefined();
    await rt.idle();
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>),
      "the marker was not actually removed, so this case is exercising an " +
        "ordinary marked root and proves nothing about the exemption",
    ).toBeUndefined();

    const { error } = await rollForward(cell, typedCount("v2"));

    expect(
      error,
      "a markerless root was validated. That may well be the better policy, " +
        "but it is a CHANGE: every root written before the marker existed " +
        "would start refusing its first repair-route update",
    ).toBeUndefined();
    // One setup wide: the update that skipped validation stamps the marker, so
    // the next one is checked. This is what bounds the exemption.
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>),
      "the exemption did not close behind itself, so this root would skip " +
        "validation on every future update rather than just this one",
    ).toBeDefined();
  });

  it("does not half-swap a RUNNING piece whose stored argument is fine", async () => {
    // The counterweight to the running-piece refusal above, and a regression
    // guard: validating on that path must not become STAGING on it.
    //
    // `applySetupState` installs the incoming version's argument schema,
    // internal manifest and result projection — but only the pattern watcher
    // can cancel the live nodes and instantiate the new ones. Staging here
    // would leave the piece's projection reading as V2 while its nodes still
    // drive V1's cells, and would stamp the completion marker forward, erasing
    // the mismatch a later repair needs to see. Measured before the fix: the
    // live value moved to the new version's without its graph ever running.
    //
    // The two versions differ in WHICH cell backs `tag`, so a staged-but-not-
    // instantiated projection is visible as a value change.
    // The versions differ in WHICH cell backs `tag` AND in their declared
    // result shape, so both halves of a partial swap are observable: a staged
    // projection shows as a value change, and a staged result SCHEMA shows in
    // the root's `schema` meta, which is what later reads resolve through.
    const stored = (
      marker: string,
      key: string,
      extra = false,
    ): RuntimeProgram =>
      programOf([
        "import { Writable, pattern } from 'commonfabric';",
        "interface Args { count?: number; [key: string]: any }",
        extra
          ? "interface Out { tag: Writable<string>; extra: Writable<number>; }"
          : "interface Out { tag: Writable<string>; }",
        "export default pattern<Args, Out>(() => {",
        `  const tag = new Writable<string>(${JSON.stringify(marker)}).for(${
          JSON.stringify(key)
        });`,
        ...(extra
          ? [
            "  const extra = new Writable<number>(0).for('extra');",
            "  return { tag, extra };",
          ]
          : ["  return { tag };"]),
        "});",
        "",
      ].join("\n"));

    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(stored("v1", "tagA"), { space, tx });
    const v2 = await pm.compilePattern(stored("v2", "tagB", true), {
      space,
      tx,
    });
    const v1Ref = pm.getArtifactEntryRef(v1)!;
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "running-half-swap",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();

    // Move the pointer. The swap refuses the stored argument and is LOGGED, so
    // the piece keeps running V1 under a pointer that reads V2 — the state a
    // repair finds.
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    });
    await tx2.commit();
    await rt.idle();
    await cell.pull();
    expect(
      (cell.getAsQueryResult() as { tag: string }).tag,
      "the swap did not refuse, so this case is not testing a running piece " +
        "with a stale setup marker",
    ).toBe("v1");

    // Now repair the argument, so validation on the repair below PASSES and the
    // only question left is whether setup moves the piece.
    const { error: fixError } = await rt.editWithRetry((wtx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, wtx)
        .asSchema(undefined as never)
        .set({ count: 7 } as never);
    });
    expect(fixError?.message).toBeUndefined();
    await rt.idle();

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), v2, undefined, {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();
    await cell.pull();

    expect(error).toBeUndefined();
    expect(
      (cell.getAsQueryResult() as { tag: string }).tag,
      "the piece's live value changed without its graph being re-instantiated " +
        "— setup staged the new version's result projection over nodes still " +
        "running the old one",
    ).toBe("v1");
    await cell.sync();
    expect(
      getPatternSetupIdentityRef(cell as Cell<unknown>)?.identity,
      "the completion marker advanced past the graph that is actually " +
        "running, which erases the mismatch a later repair uses to notice",
    ).toBe(v1Ref.identity);
    // The result SCHEMA is the other half of a partial swap, and the one most
    // easily missed: later reads resolve the root through this meta, so staging
    // the candidate's schema over a graph still running the old version makes
    // those reads describe a shape nothing is producing.
    expect(
      (cell as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("schema"),
      "the candidate's result schema was staged over a piece still running " +
        "the previous version's nodes",
    ).toEqual(v1.resultSchema);
  });

  it("does not classify a failure that merely mentions the refusal", () => {
    // The counterweight to the assertion above, and the reason the prefix is
    // matched at the START. The escalation this classifier gates REPLACES a
    // root's pattern, so a transient storage failure that happens to quote a
    // user value must not be mistaken for "the pinned pattern cannot read this
    // doc" — the same forgery concern `isCfcMigrationRejection` documents.
    expect(
      isStoredArgumentSchemaRefusal(
        new Error(`commit failed at /${STORED_ARGUMENT_SCHEMA_REFUSAL}: nope`),
      ),
      "a failure that merely CONTAINS the refusal text was classified as one, " +
        "so user-influenced content can trigger a root replacement",
    ).toBe(false);
    expect(isStoredArgumentSchemaRefusal(undefined)).toBe(false);
    expect(isStoredArgumentSchemaRefusal(STORED_ARGUMENT_SCHEMA_REFUSAL)).toBe(
      false,
    );
  });

  it("rolls a COMPATIBLE stored argument forward (control)", async () => {
    // The control this file is unsound without: if a roll-forward refused every
    // argument, the case above would pass while proving nothing about types.
    const { cell } = await setupVintage(
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
    const { cell } = await setupVintage(
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

  it("leaves a same-version setup alone over an argument its OWN schema rejects", async () => {
    // The blast-radius guard, and the reason this check keys on the setup
    // marker rather than on strictness everywhere.
    //
    // The vintage here is the TYPED pattern, and the stored argument violates
    // that pattern's own schema — a schema-less write, which is how a value
    // gets under a declared field without passing its check. Re-running setup
    // for the SAME version must leave it alone. Widen the condition to
    // "validate on every setup" and every piece in this state stops booting,
    // failing at each start rather than at the update that introduced the
    // mismatch.
    //
    // Note the vintage must be the typed pattern, not the open one: an open
    // object accepts `{count: "seven"}`, so re-staging it would validate
    // cleanly and this case would pass no matter what the condition said.
    const { cell } = await setupVintage(
      typedCount("v1"),
      undefined,
      "same-version-own-schema-mismatch",
    );
    const { error: writeError } = await rt.editWithRetry((tx) => {
      rt.getCellFromLink(getMetaLink(cell, "argument")!, undefined, tx)
        .asSchema(undefined as never)
        .set({ count: "seven" } as never);
    });
    expect(writeError?.message).toBeUndefined();
    await rt.idle();

    const pattern = await rt.patternManager.compilePattern(typedCount("v1"), {
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
      "re-running setup for the SAME version refused an argument already " +
        "stored under it, which turns a pre-existing mismatch into a piece " +
        "that will not boot",
    ).toBeUndefined();
    expect(rt.getCellFromLink(getMetaLink(cell, "argument")!).getRaw()).toEqual(
      {
        count: "seven",
      },
    );
  });

  it("refuses a roll-forward onto a RUNNING piece whose swap already failed", async () => {
    // The reuse fast path, which is a second way to reach setup with the
    // pointer already naming the candidate — and the state a refused hot-swap
    // leaves behind, so the two interact.
    //
    // Sequence: the piece runs V1; the pointer moves to V2; the armed watcher
    // swaps, its setup REFUSES the stored argument, and it is logged rather
    // than thrown — so the piece keeps running V1 while the durable pointer now
    // reads V2 and `patternSetupIdentity` still reads V1. A repair then calls
    // `runSynced` with V2, and `maybeReuseRunningSetup` sees a running piece, a
    // matching pointer, and no supplied argument: it returns before
    // `applySetupState` ever runs. Without the setup-completion identity in
    // that gate, the repair reports success over an argument nothing validated.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(openArgument("v1"), { space, tx });
    const v2 = await pm.compilePattern(typedCount("v2"), { space, tx });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "running-reuse-stale-marker",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { count: "seven" }, cell);
    await tx.commit();
    await running.pull();

    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    });
    await tx2.commit();
    await rt.idle();
    await cell.pull();
    // Precondition, asserted rather than assumed: the swap refused, so the
    // piece is still V1 under a pointer that reads V2. If this ever changes,
    // the case below is exercising a different situation than it describes.
    expect(
      (cell.getAsQueryResult() as { marker: string }).marker,
      "the swap did not refuse, so this case no longer sets up the " +
        "running-piece-with-stale-marker state it exists to test",
    ).toBe("v1");

    let error: string | undefined;
    try {
      await rt.runSynced(cell.withTx(), v2, undefined, {
        expectedPatternIdentity: v2Ref,
      });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    await rt.idle();
    await rt.storageManager.synced();

    expect(
      error,
      "a repair over a RUNNING piece reported success without validating the " +
        "stored argument: `maybeReuseRunningSetup` returned before " +
        "`applySetupState`, so the re-stage never ran",
    ).toContain("updated arguments do not match the candidate schema");
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
