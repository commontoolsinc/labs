import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

// `cf piece setsrc <main>` replaces the source of a LIVE piece. Until now the
// only way to learn whether a source could be applied was to attempt it, and
// what came back was whichever low-level rejection happened to surface first —
// a schema-subset assertion, a retained-link proof, or an argument validation
// failure at the setup-commit boundary. Fix one, meet the next.
//
// `checkPattern()` answers the question up front without changing the piece.
// (It is not a pure read — compiling the candidate writes content-addressed
// artifacts into the space — but it moves no pointer and re-stages nothing.)
// It runs the SAME review the apply path runs
// (`pieceSourceCompatibilityReview`), which is the property worth pinning: a
// preflight that reimplements the rules drifts
// from enforcement and becomes a liar. So these cases assert the two verdicts
// agree, not merely that each is individually plausible.

const signer = await Identity.fromPassphrase("pattern compatibility check");

/** The piece's current source: one optional input, one output. */
function baseProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: seed ?? 'unset',",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A later revision of the same contract: accepted. Its output is observably
 * different for the same stored argument, so applying it proves the swap
 * happened AND that the argument survived it.
 */
function compatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: `seen:${seed ?? 'unset'}`,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * Demands an input the stored argument does not carry and cannot default.
 * This is the shape that bricked home roots on estuary: a required field with
 * no default cannot migrate documents written before it existed.
 */
function incompatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ required: number }, { label: string }>(",
        "  ({ required }) => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: String(required),",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * Narrows the declared OUTPUT type, which the argument/result subset proof
 * rejects. The stored argument stays valid, so this isolates the contract rule
 * from the stored-argument rule.
 */
function narrowedOutputProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }, { label: number }>(",
        "  () => ({",
        "    [NAME]: 'Compatibility check',",
        "    label: 7,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * The CFC-labelled variants below exist because the three rules above all
 * reason about DECLARED types, and a fourth thing decides whether the setup
 * commit lands: the CFC schema envelope physically stored on the piece's
 * argument document. That envelope accumulates across every write the document
 * ever took, so it can carry claims no pattern ever declared — and the merge
 * against it rejects independently of every type-level check.
 *
 * A confidentiality label is what makes a document CFC-relevant at all
 * (without one, nothing stores an envelope and the merge never runs). It is
 * also the least entangled choice: an ownership label would demand matching
 * `represents-principal` integrity on every write, so these cases would fail
 * authorization before ever reaching the merge.
 */
const CFC_PRELUDE = [
  "import { Confidential, NAME, pattern } from 'commonfabric';",
  "const ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'SetsrcCompatibilityCheck',",
  "  subject: 'did:example:declared',",
  "} as const;",
  "type Label = readonly [typeof ATOM];",
];

/** The atom the pattern declares, as it lands in the stored envelope. */
const DECLARED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SetsrcCompatibilityCheck",
  subject: "did:example:declared",
} as const;

/** An atom NO version of the pattern declares — only a later write carries it. */
const EXTRA_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SetsrcCompatibilityCheck",
  subject: "did:example:extra",
} as const;

/**
 * A CFC-labelled piece, in two revisions whose declared contracts are
 * IDENTICAL down to the label. Keeping them identical is what isolates the
 * envelope: any ifc difference between the two patterns is caught by the
 * contract proof instead (`argument.seed: ifc changed`), which would make a
 * CFC-envelope case pass for the wrong reason.
 */
function labelledProgram(label: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        ...CFC_PRELUDE,
        "interface Args { seed: Confidential<string, Label>; }",
        "export default pattern<Args, { label: string }>(",
        "  ({ seed }) => ({",
        "    [NAME]: 'Compatibility check',",
        `    label: ${label},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

const labelledBase = () => labelledProgram("seed");
const labelledNext = () => labelledProgram("`seen:${seed}`");

describe("setsrc compatibility preflight", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    manager = new PieceManager(
      await createSession({
        identity: signer,
        spaceName: `pattern-compat-check-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await manager.synced();
    pieces = new PiecesController(manager);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const livePiece = async () =>
    await pieces.create(baseProgram(), { input: { seed: "hello" } });

  it("clears a source that can replace the current one", async () => {
    const piece = await livePiece();
    const report = await piece.checkPattern(compatibleProgram());

    expect(report.compatible).toBe(true);
    expect(report.message).toBe(undefined);
    expect(report.issues).toEqual({});
    // The verdict names the source it judged, so a caller can tell which
    // revision was cleared.
    expect(report.candidate.identity).toBeDefined();
  });

  it("refuses a source whose contract the stored argument cannot satisfy", async () => {
    const piece = await livePiece();
    const report = await piece.checkPattern(incompatibleProgram());

    expect(report.compatible).toBe(false);
    expect(report.message).toBeDefined();
    // The reason is the rule's own words, not a paraphrase invented here.
    expect(report.message).toContain("required");
  });

  it("changes nothing — a refused check leaves the piece applying its old source", async () => {
    const piece = await livePiece();
    await runtime.idle();
    const before = JSON.stringify(piece.getCell().getAsQueryResult());
    const refBefore = getPatternIdentityRef(piece.getCell());

    await piece.checkPattern(incompatibleProgram());
    await runtime.idle();

    // The piece is what must be untouched. (The check is not a pure read: it
    // compiles the candidate, which writes content-addressed artifacts into
    // the space. Those are attached to nothing — the POINTER is the thing a
    // caller cares about, so assert it directly rather than inferring it from
    // the rendered result.)
    expect(getPatternIdentityRef(piece.getCell())).toEqual(refBefore);
    expect(JSON.stringify(piece.getCell().getAsQueryResult())).toBe(before);

    // And the piece still accepts a compatible source afterwards: the refused
    // check left no half-applied state behind to trip over. The new output
    // proves the swap landed; `hello` inside it proves the stored argument
    // came through unchanged.
    await piece.setPattern(compatibleProgram());
    await runtime.idle();
    expect((piece.getCell().getAsQueryResult() as { label?: string }).label)
      .toBe("seen:hello");
  });

  it("agrees with the apply path on the verdict and the cause", async () => {
    // The contract that keeps the preflight honest: a source the check refuses
    // is refused by `setPattern`, for the same underlying reason.
    //
    // Agreement is on the VERDICT and the CAUSE, deliberately not on identical
    // prose. Enforcement lives on the apply path and reports in its own words;
    // the check reports the review's. An earlier revision of this PR made the
    // strings identical by running the review ahead of the swap, and that
    // silently changed what `setPattern` accepts (see
    // setsrc-cold-argument.test.ts). Message equality is not worth that.
    const piece = await livePiece();
    const report = await piece.checkPattern(incompatibleProgram());
    expect(report.compatible).toBe(false);

    const applied = await piece.setPattern(incompatibleProgram()).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    // Refused on both paths. The check explains why in the review's words; the
    // apply path reports in enforcement's, so only the verdict is compared.
    expect(applied).toBeDefined();
    expect(report.message).toContain("required");
  });

  /**
   * A live CFC-labelled piece whose stored argument envelope has been widened
   * past what any revision of the pattern declares.
   *
   * This is not a contrived shape: an envelope is the union of every write's
   * claims, and strengthening a label is always allowed, so any later writer
   * that presents a broader confidentiality leaves the document carrying more
   * than the pattern does. The piece is then partially migrated — its pattern
   * pointer is behind its own document — and that is the state where the three
   * type-level rules all pass and the setup commit still refuses.
   */
  const pieceWithWidenedEnvelope = async () => {
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();
    const argument = manager.getArgument(piece.getCell());
    const { error } = await runtime.editWithRetry((tx) => {
      argument.withTx(tx).asSchema({
        type: "object",
        properties: {
          seed: {
            type: "string",
            ifc: { confidentiality: [DECLARED_ATOM, EXTRA_ATOM] },
          },
        },
      } as never).set({ seed: "hello" } as never);
    });
    expect(
      error?.message,
      "the fixture could not widen the stored envelope, so the case below " +
        "would pass for want of a merge to fail rather than because the " +
        "check works",
    ).toBeUndefined();
    await runtime.idle();
    return piece;
  };

  it("clears a CFC-labelled piece whose stored envelope still matches", async () => {
    // The control for the two cases below. Carrying a CFC envelope at all must
    // not make a piece un-swappable — otherwise the new rule reads as "any
    // labelled piece is incompatible" and operators learn to ignore it.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();

    const report = await piece.checkPattern(labelledNext());
    expect(report.compatible).toBe(true);
    expect(report.issues).toEqual({});
  });

  it("refuses a source the piece's stored CFC envelope cannot merge with", async () => {
    const piece = await pieceWithWidenedEnvelope();
    const report = await piece.checkPattern(labelledNext());

    // Isolation is the claim: the contract proof, the stored-argument
    // validation and the retained-link proof ALL pass here — the two patterns
    // are identical and the stored value is a plain string. Only the envelope
    // rejects, so a check that stopped at the declared types would report this
    // source as safe to deploy.
    expect(report.issues.schema).toBe(undefined);
    expect(report.issues.argument).toBe(undefined);
    expect(report.issues.retainedLinks).toBe(undefined);
    expect(report.compatible).toBe(false);
    expect(report.issues.cfc).toBeDefined();
    // The reason is the merge's own words, not a paraphrase invented here —
    // it is the same sentence the commit rejection carries.
    expect(report.message).toContain("confidentiality cannot be weakened");
    expect(report.message).toContain("/seed");
  });

  it("predicts a real commit rejection, not a gate of its own", async () => {
    // The property that makes the verdict worth acting on. The override exists
    // precisely to bypass the preflight, so driving the apply path THROUGH it
    // reaches the enforcement layer itself: CFC still refuses the commit, over
    // the same weakening. The check is reporting something real.
    const piece = await pieceWithWidenedEnvelope();
    const report = await piece.checkPattern(labelledNext());
    expect(report.compatible).toBe(false);

    // The storage layer aborts with its own rejection shape rather than an
    // `Error`, so read the message off it directly — the point is WHOSE
    // rejection this is, and it is CFC enforcement's.
    const forced = await piece.setPattern(labelledNext(), {
      dangerouslyAllowIncompatibleSchema: true,
    }).then(
      () => undefined,
      (error: unknown) => (error as { message?: string })?.message,
    );
    expect(forced).toContain("CFC enforcement rejected commit");
    expect(forced).toContain("confidentiality cannot be weakened at /seed");

    // And without the override, the apply path refuses too — naming the same
    // cause in enforcement's own words. Agreement is on the verdict and the
    // cause, not on identical prose: making the strings match would mean
    // running the review ahead of the swap, which changes what `setPattern`
    // accepts (see setsrc-cold-argument.test.ts).
    const applied = await piece.setPattern(labelledNext()).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error.message : JSON.stringify(error),
    );
    expect(applied).toBeDefined();
    // Both name the same underlying cause, in their own words. (The apply path
    // may reject with a bare CFC rejection object rather than an `Error`, so
    // compare text rather than asserting a type.)
    expect(report.message).toContain("confidentiality cannot be weakened");
    expect(applied).toContain("confidentiality cannot be weakened");
  });

  it("refuses a piece whose stored CFC envelope cannot be read at all", async () => {
    // An envelope that exists but will not load is the tempting thing to skip:
    // there is no merge to run, so "not applicable" reads as the honest
    // answer. It is not — the commit path records that same load failure as a
    // rejection reason and refuses the write, so skipping it green-lights a
    // swap the deploy then rejects.
    const piece = await pieces.create(labelledBase(), {
      input: { seed: "hello" },
    });
    await runtime.idle();

    // Serve a different schema at the content address the metadata names.
    const link = manager.getArgument(piece.getCell())
      .getAsNormalizedFullLink();
    const metadata = readStoredCfcMetadata(runtime.readTx(), {
      space: link.space,
      id: link.id,
      scope: link.scope,
    });
    expect(
      metadata?.schemaHash,
      "the labelled fixture stored no CFC envelope, so there is nothing for " +
        "this case to poison",
    ).toBeDefined();
    const { error } = await runtime.editWithRetry((tx) => {
      tx.writeOrThrow({
        space: link.space,
        id: `cid:${metadata!.schemaHash}` as typeof link.id,
        type: "application/json",
        path: [],
      }, { value: { type: "string" } });
    });
    expect(error?.message).toBeUndefined();
    await runtime.idle();

    const report = await piece.checkPattern(labelledNext());
    expect(report.compatible).toBe(false);
    expect(report.message).toContain("could not be read");
    expect(report.message).toContain("hash mismatch");
  });

  it("still lets the dangerous override through", async () => {
    // `--dangerously-allow-incompatible-schema` exists for the case where the
    // operator knows better than the proof, and this new pre-check must not
    // become a second gate that ignores it.
    //
    // The override covers the CONTRACT proof, not the stored argument: a
    // candidate the argument cannot satisfy is still refused downstream at
    // setup (that is #5207's validation, independent of this change). So the
    // case to pin is a contract-only break — a narrowed output type, which the
    // subset proof rejects while the stored argument stays perfectly valid.
    const piece = await livePiece();
    expect((await piece.checkPattern(narrowedOutputProgram())).compatible)
      .toBe(false);

    await piece.setPattern(narrowedOutputProgram(), {
      dangerouslyAllowIncompatibleSchema: true,
    });
    await runtime.idle();
    expect((piece.getCell().getAsQueryResult() as { label?: unknown }).label)
      .toBe(7);
  });
});
