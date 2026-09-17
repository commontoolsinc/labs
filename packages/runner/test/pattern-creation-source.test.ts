import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  applyPieceSourceTransition,
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  Runtime,
  type RuntimeProgram,
} from "../src/index.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("pattern creation source");
const childSpace = (await signer.derive("child")).did();
const origin = "system:system/creation-child.tsx";

function program(
  sourceOrigin: string | undefined,
  crossSpace = true,
): RuntimeProgram {
  return {
    main: "/api/patterns/system/creation-parent.tsx",
    files: [{
      name: "/api/patterns/system/creation-parent.tsx",
      contents: `
        import { pattern } from "commonfabric";
        import Child from "./creation-child.tsx";
        export default pattern(() => ({
          child: Child${crossSpace ? `.inSpace("${childSpace}")` : ""}(
            {}, ${
        JSON.stringify(sourceOrigin === undefined ? {} : { sourceOrigin })
      }
          ),
        }));
      `,
    }, {
      name: "/api/patterns/system/creation-child.tsx",
      contents: `
        import { pattern, Writable } from "commonfabric";
        export default pattern<Record<string, never>, { value: string }>(() => ({
          value: new Writable("original").for("value"),
        }));
      `,
    }],
  };
}

describe("pattern-creation-source", () => {
  let manager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://creation.test"),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.dispose();
    await manager.close();
  });

  async function create(sourceOrigin?: string, crossSpace = true) {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(
      program(sourceOrigin, crossSpace),
      { space: signer.did(), tx },
    );
    const parent = runtime.getCell(signer.did(), "parent");
    runtime.runner.run(tx, pattern, {}, parent);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await parent.pull();
    const child = parent.key("child").asSchema<Cell<unknown>>({
      type: "unknown",
      asCell: ["cell"],
    }).get().withTx();
    return { parent, child, pattern };
  }

  for (const crossSpace of [false, true]) {
    it(`records one creation revision for a ${crossSpace ? "cross" : "same"}-space invocation`, async () => {
      using _copy = stub(runtime.patternManager, "replicatePatternToSpace");
      const { parent, child, pattern } = await create(origin, crossSpace);
      expect(child.space).toBe(crossSpace ? childSpace : signer.did());
      expect(getPatternSource(child)).toBe(origin);
      const revisions = getPieceSourceRevisions(child);
      expect(revisions.map((revision) => revision.operation)).toEqual([
        "create",
      ]);
      expect(
        await runtime.patternManager.getPatternSourceProgramByIdentity(
          getPatternIdentityRef(child)!.identity,
          child.space,
        ),
      ).toBeDefined();

      runtime.runner.stop(parent);
      const tx = runtime.edit();
      runtime.runner.run(tx, pattern, {}, parent);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await parent.pull();
      expect(getPieceSourceRevisions(child)).toEqual(revisions);
    });
  }

  it("leaves ordinary invocations detached", async () => {
    const { child } = await create();
    expect(getPatternSource(child)).toBeUndefined();
    expect(getPieceSourceRevisions(child)).toEqual([]);
  });

  it("preserves an owner's detach when the parent runs again", async () => {
    const { parent, child, pattern } = await create(origin);
    const snapshot = getPieceSourceSnapshot(child)!;
    const detach = runtime.edit();
    applyPieceSourceTransition(runtime, child, detach, snapshot.pattern, {
      revisionId: "owner-detach",
      timestamp: 1,
      operation: "detach",
      origin: null,
      baseline: { kind: "retain", revisionId: "baseline" },
      expected: snapshot,
    });
    runtime.prepareTxForCommit(detach);
    expect((await detach.commit()).error).toBeUndefined();
    const revisions = getPieceSourceRevisions(child);
    expect(getPatternSource(child)).toBeUndefined();

    runtime.runner.stop(parent);
    const tx = runtime.edit();
    runtime.runner.run(tx, pattern, {}, parent);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await parent.pull();
    expect(getPatternSource(child)).toBeUndefined();
    expect(getPieceSourceRevisions(child)).toEqual(revisions);
    expect(getPatternIdentityRef(child)).toEqual(snapshot.pattern);
  });

  it("preserves an owner's edited code when the parent runs again", async () => {
    const { parent, child, pattern } = await create(origin);
    const snapshot = getPieceSourceSnapshot(child)!;
    const editedProgram = program(origin);
    editedProgram.main = editedProgram.files[1].name;
    editedProgram.files[1].contents = editedProgram.files[1].contents.replace(
      '"original"',
      '"edited"',
    );
    const edited = await runtime.patternManager.compilePattern(editedProgram, {
      space: child.space,
    });
    await runtime.runner.runSynced(child, edited, undefined, {
      pieceSourceTransition: {
        revisionId: "owner-edit",
        timestamp: 1,
        operation: "edit",
        origin: null,
        baseline: { kind: "retain", revisionId: "baseline" },
        expected: snapshot,
      },
    });
    const editedRef = getPatternIdentityRef(child);
    expect(editedRef).not.toEqual(snapshot.pattern);
    const revisions = getPieceSourceRevisions(child);

    runtime.runner.stop(parent);
    const tx = runtime.edit();
    runtime.runner.run(tx, pattern, {}, parent);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await parent.pull();
    expect(getPatternIdentityRef(child)).toEqual(editedRef);
    expect(getPatternSource(child)).toBeUndefined();
    expect(getPieceSourceRevisions(child)).toEqual(revisions);

    const fresh = new Runtime({
      apiUrl: new URL("https://creation.test"),
      storageManager: manager,
    });
    try {
      const resumed = fresh.getCellFromLink(parent.getAsNormalizedFullLink());
      expect(await fresh.start(resumed)).toBe(true);
      await resumed.pull();
      await fresh.idle();
      const childKey = `${child.space}/space/${child.sourceURI}` as const;
      expect(fresh.runner.cancels.has(childKey)).toBe(true);
      expect(getPatternIdentityRef(child)).toEqual(editedRef);
      expect(getPieceSourceRevisions(child)).toEqual(revisions);
      fresh.runner.stop(resumed);
      expect(fresh.runner.cancels.has(childKey)).toBe(false);
    } finally {
      await fresh.dispose();
    }
  });

  it("cancels a resumed child when its parent stops before committing", async () => {
    const { parent, child, pattern } = await create(origin);
    runtime.runner.stop(parent);
    const tx = runtime.edit();
    runtime.runner.run(tx, pattern, {}, parent);
    runtime.runner.stop(parent);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.cancels.has(
      `${child.space}/space/${child.sourceURI}`,
    )).toBe(false);
  });

  it("refuses an unusable origin before publishing a child", async () => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(
      program("https://external.test/not-a-pattern"),
      { space: signer.did(), tx },
    );
    const parent = runtime.getCell(signer.did(), "parent");
    expect(() => runtime.runner.run(tx, pattern, {}, parent))
      .toThrow("invalid creation source origin");
    tx.abort("invalid source origin");
    expect(getPatternIdentityRef(parent)).toBeUndefined();
  });

  it("refuses creation when neither space retains the source", async () => {
    using copy = stub(runtime.patternManager, "replicatePatternToSpace");
    const elsewhere = (await signer.derive("elsewhere")).did();
    const pattern = await runtime.patternManager.compilePattern(
      program(origin),
      {
        space: elsewhere,
      },
    );
    const tx = runtime.edit();
    const parent = runtime.getCell(signer.did(), "parent");
    expect(() => runtime.runner.run(tx, pattern, {}, parent))
      .toThrow("source unavailable for tracked creation");
    expect(copy.calls).toHaveLength(0);
    tx.abort("missing source");
    expect(getPatternIdentityRef(parent)).toBeUndefined();
  });
});
