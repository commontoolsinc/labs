import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "@commonfabric/runner";

import type { Cell as BuilderCell } from "../../../runner/src/builder/types.ts";
import {
  collectLinkPaths,
  documentChanges,
  evaluateFixer,
  repairPieces,
} from "../../src/ops/bulk-repair.ts";
import type { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { surveyPieces } from "../../src/ops/bulk-survey.ts";

const signer = await Identity.fromPassphrase("bulk repair");

/** A sigil link the way a raw stored document spells one. */
function sigil(id: string): Record<string, unknown> {
  return { "/": { "link@1": { id, path: [] } } };
}

/** A member program whose stored input carries a `seed`. */
function memberProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(({ seed }) => ({",
        "  [NAME]: 'Member',",
        "  seed,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/** A holder whose stored input carries the member collection and a title. */
function holderProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ title?: string; members?: unknown[] }>(",
        "  ({ title, members }) => ({",
        "    [NAME]: 'Holder',",
        "    title,",
        "    members,",
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

/** Uppercase the seed; the smallest fixer with something to do. */
function upperSeed(
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...document,
    ...(typeof document.seed === "string"
      ? { seed: document.seed.toUpperCase() }
      : {}),
  };
}

describe("bulk-repair", () => {
  describe("documentChanges()", () => {
    it("returns one row per changed leaf, with the exact values", () => {
      const changes = documentChanges(
        { a: 1, nested: { keep: true, flip: "x" } },
        { a: 2, nested: { keep: true, flip: "y" } },
      );
      expect(changes).toEqual([
        { path: "a", before: 1, after: 2 },
        { path: "nested/flip", before: "x", after: "y" },
      ]);
    });

    it("reports a replaced container as one change, not its every leaf", () => {
      const changes = documentChanges({ list: [1, 2, 3] }, { list: "gone" });
      expect(changes).toEqual([
        { path: "list", before: [1, 2, 3], after: "gone" },
      ]);
    });

    it("returns no rows for equal documents", () => {
      expect(documentChanges({ a: [1] }, { a: [1] })).toEqual([]);
    });
  });

  describe("collectLinkPaths()", () => {
    it("finds every sigil link by path, and descends no further into one", () => {
      const doc = {
        title: "t",
        members: [sigil("of:fid1:a"), sigil("of:fid1:b")],
        wrap: { inner: sigil("of:fid1:c") },
      };
      expect(collectLinkPaths(doc)).toEqual([
        ["members", "0"],
        ["members", "1"],
        ["wrap", "inner"],
      ]);
    });
  });

  describe("evaluateFixer()", () => {
    const linkedDoc = {
      title: "t",
      members: [sigil("of:fid1:a")],
    };

    it("classifies an unchanged answer as conforming", () => {
      expect(evaluateFixer({ seed: "A" }, (d) => ({ ...d }))).toEqual({
        kind: "conforms",
      });
    });

    it("returns the changed document with its exact changes", () => {
      const outcome = evaluateFixer({ seed: "a", keep: 1 }, upperSeed);
      expect(outcome).toEqual({
        kind: "change",
        document: { seed: "A", keep: 1 },
        changes: [{ path: "seed", before: "a", after: "A" }],
      });
    });

    it("refuses a fixer that throws, naming the message", () => {
      const outcome = evaluateFixer({ seed: "a" }, () => {
        throw new Error("cannot read this shape");
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("cannot read this shape");
    });

    it("refuses an answer that is not a document", () => {
      const outcome = evaluateFixer(
        { seed: "a" },
        () => [] as unknown as Record<string, unknown>,
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("not a document");
    });

    it("refuses a fixer whose two runs answer differently", () => {
      let calls = 0;
      const outcome = evaluateFixer({ seed: "a" }, (d) => {
        calls += 1;
        return { ...d, stamp: calls };
      });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("pure function");
    });

    it("refuses an incomplete document, naming the fields the write would lose", () => {
      const outcome = evaluateFixer(
        { seed: "a", keep: 1, also: 2 },
        (d) => ({ seed: d.seed }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("keep, also");
    });

    it("refuses a nested field the answer lost, wherever the container survived", () => {
      const outcome = evaluateFixer(
        { meta: { author: "a", stamp: "s" }, seed: "x" },
        (d) => ({
          ...d,
          meta: { author: (d.meta as Record<string, unknown>).author },
        }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("meta/stamp");
    });

    it("refuses a field returned as an explicit undefined, which the write drops", () => {
      const outcome = evaluateFixer(
        { seed: "a", keep: 1 },
        (d) => ({ ...d, keep: undefined }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("keep");
    });

    it("treats a container replaced outright as a change, not a fragment", () => {
      const outcome = evaluateFixer(
        { wrap: { a: 1, b: 2 }, seed: "x" },
        (d) => ({ ...d, wrap: 7 }),
      );
      expect(outcome.kind).toBe("change");
      if (outcome.kind !== "change") throw new Error("expected a change");
      expect(outcome.changes).toEqual([
        { path: "wrap", before: { a: 1, b: 2 }, after: 7 },
      ]);
    });

    it("lets an array shrink, and still guards an element's own fields", () => {
      const dedup = evaluateFixer(
        { tags: ["a", "a", "b"] },
        (d) => ({ ...d, tags: [...new Set(d.tags as string[])] }),
      );
      expect(dedup.kind).toBe("change");
      const outcome = evaluateFixer(
        { rows: [{ id: 1, note: "n" }] },
        (d) => ({ ...d, rows: [{ id: 1 }] }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("rows/0/note");
    });

    it("addresses a key containing the separator unambiguously", () => {
      const doc = { "a/b": sigil("of:fid1:slash"), seed: "x" };
      const kept = evaluateFixer(doc, (d) => ({ ...d, seed: "y" }));
      expect(kept.kind).toBe("change");
      const dropped = evaluateFixer(doc, (d) => ({
        seed: d.seed,
        "a/b": "gone",
      }));
      expect(dropped.kind).toBe("refused");
      if (dropped.kind !== "refused") throw new Error("expected a refusal");
      expect(dropped.problem).toContain("a~1b");
    });

    it("refuses a fixer that rewrites a link as a value", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        members: ["of:fid1:a"],
      }));
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("members/0");
    });

    it("refuses a fixer that drops a link", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        members: [],
      }));
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("members/0");
    });

    it("accepts a change beside an untouched link", () => {
      const outcome = evaluateFixer(linkedDoc, (d) => ({
        ...d,
        title: "renamed",
      }));
      expect(outcome.kind).toBe("change");
      if (outcome.kind !== "change") throw new Error("expected a change");
      expect(outcome.changes).toEqual([
        { path: "title", before: "t", after: "renamed" },
      ]);
    });

    it("refuses a fixer that replaces the container a nested link lives in", () => {
      const outcome = evaluateFixer(
        { wrap: { inner: sigil("of:fid1:c") } },
        (d) => ({ ...d, wrap: "gone" }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("wrap/inner");
    });

    it("refuses to alter a document that is itself a link", () => {
      const outcome = evaluateFixer(
        sigil("of:fid1:whole"),
        (d) => ({ ...d, extra: 1 }),
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("expected a refusal");
      expect(outcome.problem).toContain("<root>");
    });

    it("is safe against a fixer that mutates its argument", () => {
      const document = { seed: "a" };
      const outcome = evaluateFixer(document, (d) => {
        (d as Record<string, unknown>).seed = "MUTATED";
        return d as Record<string, unknown>;
      });
      expect(outcome.kind).toBe("change");
      expect(document.seed).toBe("a");
    });
  });

  describe("repairPieces()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `bulk-repair-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    async function member(seed: string): Promise<PieceController> {
      return await pieces.create(memberProgram(), { input: { seed } });
    }

    async function seedHolder(
      members: PieceController[],
    ): Promise<PieceController> {
      const holder = await pieces.create(holderProgram(), { input: {} });
      await holder.input.set(members.map((m) => m.getCell()), ["members"]);
      await pieces.runtime.idle();
      return holder;
    }

    function collectionOf(holder: PieceController) {
      return {
        kind: "collection" as const,
        holder: holder.id,
        path: ["members"],
      };
    }

    async function rawInput(
      piece: PieceController,
    ): Promise<Record<string, unknown>> {
      const cell = await piece.input.getCell();
      await cell.pull();
      return cell.getRaw({ lastNode: "value" }) as Record<string, unknown>;
    }

    it("reports the exact per-piece diff on a dry run, and writes nothing", async () => {
      const a = await member("alpha");
      const b = await member("BRAVO");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
      });

      expect(report.rows).toEqual([
        {
          piece: a.id,
          phase: "members",
          verdict: "would-change",
          changes: [{ path: "seed", before: "alpha", after: "ALPHA" }],
        },
        { piece: b.id, phase: "members", verdict: "conforms" },
      ]);
      expect(report.applied).toBe(0);
      expect(report.complete).toBe(true);
      expect((await rawInput(a)).seed).toBe("alpha");
    });

    it("does not repair the holder's own row on a collection selector", async () => {
      const a = await member("ALPHA");
      const holder = await seedHolder([a]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        // A fixer the holder's document would fail loudly: it returns only
        // the members' own field, so touching the holder would refuse the
        // run as an incomplete document.
        fixer: (d) => ({ seed: d.seed }),
      });

      expect(report.rows.map((row) => row.piece)).toEqual([a.id]);
    });

    it("applies serially, verifies by re-asking the fixer, and a re-run writes nothing", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const applied = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        apply: true,
      });
      expect(applied.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "repaired",
      ]);
      expect(applied.applied).toBe(2);
      expect(applied.complete).toBe(true);
      expect((await rawInput(a)).seed).toBe("ALPHA");
      expect((await rawInput(b)).seed).toBe("BRAVO");

      const again = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: upperSeed,
        apply: true,
      });
      expect(again.rows.map((row) => row.verdict)).toEqual([
        "conforms",
        "conforms",
      ]);
      expect(again.applied).toBe(0);
    });

    it("carries links through a repair that does not mention them", async () => {
      const a = await member("alpha");
      const holder = await seedHolder([a]);
      await holder.input.set("untitled", ["title"]);
      await pieces.runtime.idle();
      const before = await rawInput(holder);

      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [holder.id] },
        fixer: (d) => ({ ...d, title: "repaired" }),
        apply: true,
      });
      expect(report.rows[0].verdict).toBe("repaired");

      const after = await rawInput(holder);
      expect(after.title).toBe("repaired");
      expect(after.members).toEqual(before.members);
      // The strongest proof the link survived: the collection still
      // resolves its member through it.
      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });
      expect(survey.complete).toBe(true);
      expect(survey.plan.rows.map((row) => row.piece)).toContain(a.id);
    });

    it("stops an apply at the first refusal and names the rest unattempted", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const c = await member("charlie");
      const holder = await seedHolder([a, b, c]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: (d) => {
          if (d.seed === "bravo") throw new Error("this one is beyond me");
          return { ...d, seed: (d.seed as string).toUpperCase() };
        },
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "repaired",
        "refused",
        "unattempted",
      ]);
      expect(report.rows[2].piece).toBe(c.id);
      expect(report.applied).toBe(1);
      expect(report.complete).toBe(false);
      expect((await rawInput(c)).seed).toBe("charlie");
    });

    it("refuses a piece whose stored input is not a document", async () => {
      // A pattern may type its whole input as a scalar, and such a piece
      // stores one — a state a document repair must refuse, not reshape.
      const scalarProgram: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<string>((text) => ({",
            "  [NAME]: 'Scalar',",
            "  text,",
            "}));",
            "",
          ].join("\n"),
        }],
      };
      const a = await pieces.create(scalarProgram, {
        input: "just a string" as never,
      });

      const report = await repairPieces(pieces, {
        selector: { kind: "list", pieces: [a.id] },
        fixer: upperSeed,
      });

      expect(report.rows).toEqual([
        {
          piece: a.id,
          phase: "list",
          verdict: "refused",
          problem: "The stored input is not a document.",
        },
      ]);
      expect(report.complete).toBe(false);
    });

    it("fails a pure but non-idempotent fixer at verification, and stops", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        // Pure — one document always answers one way — but its own answer
        // never satisfies it, so the post-write verification cannot pass.
        fixer: (d) => ({ ...d, seed: `${d.seed}X` }),
        apply: true,
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "failed",
        "unattempted",
      ]);
      expect(report.rows[0].problem).toContain("does not satisfy the fixer");
      expect(report.applied).toBe(1);
      expect(report.complete).toBe(false);
      expect((await rawInput(b)).seed).toBe("bravo");
    });

    it("reports every refusal on a dry run instead of stopping", async () => {
      const a = await member("alpha");
      const b = await member("bravo");
      const holder = await seedHolder([a, b]);

      const report = await repairPieces(pieces, {
        selector: collectionOf(holder),
        fixer: () => {
          throw new Error("refuses everything");
        },
      });

      expect(report.rows.map((row) => row.verdict)).toEqual([
        "refused",
        "refused",
      ]);
      expect(report.complete).toBe(false);
      expect(report.applied).toBe(0);
    });

    it("refuses to repair over an incomplete selection, naming the orphan", async () => {
      const { commonfabric } = createBuilder();
      const { handler, pattern } = commonfabric;
      const addPiece = handler<
        { piece: BuilderCell<unknown> },
        { pieceRegistry: BuilderCell<BuilderCell<unknown>[]> }
      >(
        true,
        {
          type: "object",
          properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
        },
        ({ piece }, { pieceRegistry }) => {
          pieceRegistry.push(piece);
        },
      );
      const defaultPattern = pattern<{ pieceRegistry: BuilderCell<unknown>[] }>(
        ({ pieceRegistry }) => ({
          pieceRegistry,
          addPiece: addPiece({ pieceRegistry }),
        }),
      );
      const home = await pieces.runPersistent(
        defaultPattern,
        { pieceRegistry: [] },
        "bulk-repair-default-pattern",
      );
      await pieces.linkDefaultPattern(home);
      await pieces.runtime.idle();
      await pieces.synced();

      const inBoard = await member("alpha");
      const orphan = await member("omega");
      await pieces.add([orphan.getCell()]);
      const holder = await seedHolder([inBoard]);

      await expect(
        repairPieces(pieces, {
          selector: collectionOf(holder),
          fixer: upperSeed,
          apply: true,
        }),
      ).rejects.toThrow("registered outside the selection");
      expect((await rawInput(inBoard)).seed).toBe("alpha");
    });
  });
});
