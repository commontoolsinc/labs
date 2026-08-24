import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../../../runner/src/builder/factory.ts";
import type { Cell as BuilderCell } from "../../../runner/src/builder/types.ts";
import { pieceId } from "../../src/piece-id.ts";
import { surveyPieces } from "../../src/ops/bulk-survey.ts";
import type { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("bulk survey");

/** A member-generation program; `version` is what tells generations apart. */
function generationProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(() => ({",
        "  [NAME]: 'Member',",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/** A holder whose stored input carries the member collection. */
function holderProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ members?: unknown[] }>(({ members }) => ({",
        "  [NAME]: 'Holder',",
        "  members,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

describe("bulk-survey", () => {
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
        spaceName: `bulk-survey-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A registry-bearing default pattern, as the space's home would provide. */
  async function installDefaultPattern(): Promise<void> {
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
    const piece = await pieces.runPersistent(
      defaultPattern,
      { pieceRegistry: [] },
      "bulk-survey-default-pattern",
    );
    await pieces.linkDefaultPattern(piece);
    await pieces.runtime.idle();
    await pieces.synced();
  }

  /** A holder with `members` linked to the given pieces, children first. */
  async function seedHolder(
    members: PieceController[],
  ): Promise<PieceController> {
    const holder = await pieces.create(holderProgram(), { input: {} });
    await holder.input.set(members.map((member) => member.getCell()), [
      "members",
    ]);
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

  describe("surveyPieces()", () => {
    it("returns members in stored order, then the holder, phase-labeled", async () => {
      const a = await pieces.create(generationProgram("a"), { input: {} });
      const b = await pieces.create(generationProgram("b"), { input: {} });
      const holder = await seedHolder([a, b]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });

      expect(survey.plan.rows.map((row) => row.piece)).toEqual(
        [a.id, b.id, holder.id],
      );
      expect(survey.plan.rows.map((row) => row.phase)).toEqual(
        ["members", "members", "holder"],
      );
    });

    it("returns one identity for pieces of one generation, another for the other", async () => {
      const a1 = await pieces.create(generationProgram("a"), { input: {} });
      const a2 = await pieces.create(generationProgram("a"), { input: {} });
      const b = await pieces.create(generationProgram("b"), { input: {} });
      const holder = await seedHolder([a1, a2, b]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });

      const [ra1, ra2, rb, rh] = survey.plan.rows;
      expect(ra1.expect.patternIdentity).toBe(ra2.expect.patternIdentity);
      expect(rb.expect.patternIdentity).not.toBe(ra1.expect.patternIdentity);
      expect(rh.expect.patternIdentity).not.toBe(ra1.expect.patternIdentity);
      expect(survey.tally).toEqual([
        {
          phase: "members",
          patternIdentity: ra1.expect.patternIdentity,
          count: 2,
        },
        {
          phase: "members",
          patternIdentity: rb.expect.patternIdentity,
          count: 1,
        },
        {
          phase: "holder",
          patternIdentity: rh.expect.patternIdentity,
          count: 1,
        },
      ]);
    });

    it("returns retained for source-created pieces and not for a builder-run one", async () => {
      await installDefaultPattern();
      const a = await pieces.create(generationProgram("a"), { input: {} });
      const holder = await seedHolder([a]);

      const sourced = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });
      expect(sourced.plan.rows.every((row) => row.expect.retained)).toBe(true);

      // The default pattern ran from a builder value: it carries a durable
      // `keyless:` identity, and no source closure is stored for one.
      const defaultPiece = await pieces.getDefaultPattern(false);
      const defaultId = pieceId(defaultPiece!);
      const builderRun = await surveyPieces(pieces, {
        selector: { kind: "list", pieces: [defaultId!] },
      });
      expect(builderRun.plan.rows).toHaveLength(1);
      expect(builderRun.plan.rows[0].expect.retained).toBe(false);
    });

    it("reflects a source change on the next survey", async () => {
      const a = await pieces.create(generationProgram("a"), { input: {} });
      const b = await pieces.create(generationProgram("b"), { input: {} });
      const holder = await seedHolder([a, b]);
      const before = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });

      const moved = await pieces.get(a.id, false);
      await moved.setPattern(generationProgram("b"));
      await pieces.runtime.idle();

      const after = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });
      expect(after.plan.rows[0].expect.patternIdentity).toBe(
        before.plan.rows[1].expect.patternIdentity,
      );
      expect(after.plan.rows[0].expect.patternIdentity).not.toBe(
        before.plan.rows[0].expect.patternIdentity,
      );
      // The transition appended a revision, and the survey read it.
      expect(after.plan.rows[0].expect.revisionId).toBeDefined();
    });

    it("returns a registered in-scope piece the collection lacks, and incomplete", async () => {
      await installDefaultPattern();
      const inBoard = await pieces.create(generationProgram("a"), {
        input: {},
      });
      const orphan = await pieces.create(generationProgram("a"), {
        input: {},
      });
      await pieces.add([orphan.getCell()]);
      const holder = await seedHolder([inBoard]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });

      expect(survey.outside).toEqual([{
        piece: orphan.id,
        patternIdentity: survey.plan.rows[0].expect.patternIdentity,
      }]);
      expect(survey.plan.header.enumerated).toEqual({
        collection: 1,
        registry: 1,
        registeredOutside: 1,
      });
      expect(survey.complete).toBe(false);
    });

    it("ignores registered pieces whose identity is out of scope, and is complete", async () => {
      await installDefaultPattern();
      const member = await pieces.create(generationProgram("a"), {
        input: {},
      });
      const unrelated = await pieces.create(generationProgram("z"), {
        input: {},
      });
      await pieces.add([unrelated.getCell()]);
      const holder = await seedHolder([member]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
      });

      expect(survey.outside).toEqual([]);
      expect(survey.complete).toBe(true);
    });

    it("stamps the phase's retarget onto its rows and leaves other phases bare", async () => {
      const a = await pieces.create(generationProgram("a"), { input: {} });
      const holder = await seedHolder([a]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
        operations: {
          members: {
            source: { main: "topic.tsx" },
            rev: "abc",
            patternIdentity: "target-identity",
          },
        },
      });

      expect(survey.plan.rows[0].op).toEqual({
        kind: "retarget",
        source: { main: "topic.tsx" },
        rev: "abc",
        patternIdentity: "target-identity",
      });
      expect(survey.plan.rows[1].op).toBeUndefined();
    });

    it("names each piece whose result fails the validator schema", async () => {
      const a = await pieces.create(generationProgram("a"), { input: {} });
      const holder = await seedHolder([a]);

      const survey = await surveyPieces(pieces, {
        selector: collectionOf(holder),
        validator: {
          type: "object",
          properties: { absent: { type: "string" } },
          required: ["absent"],
        },
      });

      expect(survey.validatorFailures.map((failure) => failure.piece))
        .toEqual([a.id, holder.id]);
      // A validator finding is a finding, not an incomplete selection.
      expect(survey.complete).toBe(true);
    });
  });
});
