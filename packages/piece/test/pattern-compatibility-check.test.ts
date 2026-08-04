import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
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

  it("agrees with the apply path, and names the same reason", async () => {
    // The contract that keeps the preflight honest. Both run the same review,
    // so a source the check refuses is refused by `setPattern` FOR THE SAME
    // STATED REASON — otherwise the preflight is advice nobody can act on.
    const piece = await livePiece();
    const report = await piece.checkPattern(incompatibleProgram());
    expect(report.compatible).toBe(false);

    const applied = await piece.setPattern(incompatibleProgram()).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(applied).toBeInstanceOf(Error);
    expect(applied!.message).toBe(report.message);
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
