/**
 * What a caller can still observe about a topic it filed through the board,
 * once the board demands only the fields it renders.
 *
 * These three properties were pattern tests until the board's `topics` demand
 * narrowed. A pattern test can only reach a stored topic through the holder's
 * projection, and that projection no longer carries verbs, threads, or the
 * mention graph — so the properties stopped being observable there. They are
 * observable here, because this is the move the design says a caller makes:
 * survey the board, resolve the row to the topic's own address, and read or
 * call the topic itself, where its own schema governs.
 *
 * Each `it()` therefore guards a property of `addTopic`'s children that nothing
 * else can: that the child is wired to the board's mention pivot, that a body
 * given at create is not recorded as a body update, and that the board's index
 * row tracks the child's thread after the fact.
 */
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { join } from "@std/path";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";
import { topicAt } from "./topic-board-fixture.ts";

const { API_URL, SPACE_NAME } = env;

describe("topic-board-child-contract", () => {
  let cc: PiecesController;
  let board: PieceController;
  let releaseBoard: (() => void) | undefined;

  beforeAll(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "topics", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    board = await cc.create(program, { start: true });
    // Held live for the whole suite so each `addTopic` lands against an
    // up-to-date list, the same reason the seeding fixture holds it.
    releaseBoard = cc.getResult(board.getCell()).sink(() => {});

    // Index 0 is filed with a body; index 1 mentions it.
    await board.result.set(
      {
        title: "Cited topic",
        body: "    indented code\nline two\n",
        agentName: "Sol",
      },
      ["addTopic"],
    );
    await board.result.set(
      { title: "Citing topic", agentName: "Sol" },
      ["addTopic"],
    );
  });

  afterAll(async () => {
    releaseBoard?.();
    await cc?.dispose();
  });

  it("leaves the body-update stamps unset on a topic filed with a body", async () => {
    const cited = await topicAt(board, 0);
    // Verbatim, because trimming would corrupt whitespace-sensitive Markdown.
    expect(await cited.result.get(["body"])).toBe(
      "    indented code\nline two\n",
    );
    // Created-with is not an update: `createdBy` covers create authorship, so
    // the update stamps must still be untouched.
    expect(await cited.result.get(["bodyUpdatedAt"]) ?? 0).toBe(0);
    expect(
      (await cited.result.get(["bodyUpdatedBy", "name"])) ?? "",
    ).toBe("");
  });

  it("wires a filed topic to the board's pivot, so a sibling's mention becomes an inbound reference", async () => {
    const cited = await topicAt(board, 0);
    const citing = await topicAt(board, 1);

    expect((await cited.result.get(["referencedBy"]) as unknown[]).length)
      .toBe(0);

    await citing.result.set({ topic: cited.getCell() }, ["mention"]);

    // The edge exists only if `addTopic` handed this child the board's
    // `crossrefs` pivot — which is the thing no pattern test can still see.
    const inbound = await cited.result.get(["referencedBy"]) as {
      title: string;
    }[];
    expect(inbound.length).toBe(1);
    expect(inbound[0].title).toBe("Citing topic");

    // Mentioning is not symmetric.
    expect((await citing.result.get(["referencedBy"]) as unknown[]).length)
      .toBe(0);
  });

  it("carries the updated comment count on the board's index row", async () => {
    const cited = await topicAt(board, 0);
    const before = await board.result.get(["index", 0, "commentCount"]) ?? 0;

    await cited.result.set({ body: "a comment", agentName: "Sol" }, [
      "addComment",
    ]);

    // The row is built from the topic rather than copied from it, so a row
    // already handed out has to reflect a thread that grew afterwards.
    expect(await board.result.get(["index", 0, "commentCount"]))
      .toBe((before as number) + 1);
  });
});

/**
 * The board's mention pivot, exercised where it is still reachable.
 *
 * `crossrefTable` derives the whole reference graph once on the board, and each
 * topic reads its own row out of it. Testing that needs two things at the same
 * time: topics that are ON a board, so the pivot sees them, and `mention` /
 * `unmention` / `referencedBy` on those same topics. A pattern test can no
 * longer have both — the board's demand carries no verbs, and a topic
 * constructed in a pattern body cannot be placed on a board either (pushing one
 * in reports a schema mismatch and the action never runs; seeding the array at
 * construction fails because `Cell.of()` takes static data only).
 *
 * Here both hold, because a caller files through the board and then addresses
 * the created topic by its own fid.
 */
describe("topic-board-pivot-contract", () => {
  let cc: PiecesController;
  let board: PieceController;
  let releaseBoard: (() => void) | undefined;
  let target: PieceController;
  let source: PieceController;
  let third: PieceController;

  beforeAll(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "topics", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    board = await cc.create(program, { start: true });
    releaseBoard = cc.getResult(board.getCell()).sink(() => {});

    for (const title of ["Graph target", "Graph source", "Graph third"]) {
      await board.result.set({ title, agentName: "Sol" }, ["addTopic"]);
    }
    target = await topicAt(board, 0);
    source = await topicAt(board, 1);
    third = await topicAt(board, 2);
  });

  afterAll(async () => {
    releaseBoard?.();
    await cc?.dispose();
  });

  const inbound = async (t: PieceController) =>
    (await t.result.get(["referencedBy"])) as { title: string }[];
  const outbound = async (t: PieceController) =>
    (await t.result.get(["mentions"])) as unknown[];

  it("builds one pivot row per topic, claiming no edges before any mention", async () => {
    expect(((await board.result.get(["crossrefs"])) as unknown[]).length)
      .toBe(3);
    expect((await inbound(target)).length).toBe(0);
    expect((await outbound(target)).length).toBe(0);
  });

  it("records a self-mention without earning the topic an inbound edge", async () => {
    // Referencing yourself is not being referenced from somewhere else. The
    // rule is asked of the topic's identity rather than its array position.
    await target.result.set({ topic: target.getCell() }, ["mention"]);
    expect((await outbound(target)).length).toBe(1);
    expect((await inbound(target)).length).toBe(0);
  });

  it("gives each mentioned topic its own inbound edge, and is not symmetric", async () => {
    await source.result.set({ topic: target.getCell() }, ["mention"]);
    await source.result.set({ topic: third.getCell() }, ["mention"]);

    expect((await outbound(source)).length).toBe(2);
    const intoTarget = await inbound(target);
    expect(intoTarget.length).toBe(1);
    expect(intoTarget[0].title).toBe("Graph source");
    expect((await inbound(third)).length).toBe(1);
    // Mentioning is not mutual.
    expect((await inbound(source)).length).toBe(0);
  });

  it("drops only the retracted edge on unmention, leaving the other standing", async () => {
    await source.result.set({ topic: target.getCell() }, ["unmention"]);

    expect((await outbound(source)).length).toBe(1);
    expect((await inbound(target)).length).toBe(0);
    // The edge that was not retracted survives as a reference, not a
    // flattened copy of the piece it names.
    const intoThird = await inbound(third);
    expect(intoThird.length).toBe(1);
    expect(intoThird[0].title).toBe("Graph source");
  });
});
