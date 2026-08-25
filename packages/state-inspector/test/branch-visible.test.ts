/**
 * A child branch inherits every entity its parent held at the fork, and the
 * surfaces that DESCRIBE entities have to see the same set a read does — or
 * they answer "no history", "no contention", "not here" about entities the same
 * branch reads fine, which is indistinguishable from those things being true.
 *
 * Ownership is the other half, and it cuts the other way: an entity the child
 * OVERRODE has a parent log that produced nothing the child can see, so
 * describing it with the parent's writes would credit revisions no read from
 * here can reach. Every case below pins both directions.
 *
 * Surfaces that describe a branch's ACTIVITY rather than its entities —
 * `spaceTimeline`, `churn` — stay branch-local on purpose, and the last case
 * here holds that line so it reads as a decision rather than an oversight.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import { entityHistory, hotEntities } from "../queries.ts";
import { contendedEntities } from "../conflicts.ts";
import { entityTimeline, spaceTimeline } from "../timetravel.ts";
import { analyzeSpaceSignals } from "../grouping.ts";
import { reconstructDocument } from "../reconstruct.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq) VALUES ('', 999);
`;

const ALICE = "session:did%3Akey%3AzAlice:s1";
const BOB = "session:did%3Akey%3AzBob:s2";

interface Write {
  branch?: string;
  id: string;
  session?: string;
  value: unknown;
}

/**
 * Seed a space, forking `kid` after the parent's writes so everything written
 * on the parent is inherited and everything on `kid` is the child's own.
 */
async function withFork(
  parent: Write[],
  child: Write[],
  run: (space: SpaceDb) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "branch-visible-" });
  const path = `${dir}/space.sqlite`;
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, ?, '{}', '{"seq":0}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (branch, id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  const write = (w: Write) => {
    seq++;
    const branch = w.branch ?? "";
    commit.run(seq, branch, w.session ?? ALICE, seq);
    rev.run(branch, w.id, seq, JSON.stringify({ value: w.value }), seq);
  };
  parent.forEach(write);
  const forkSeq = seq;
  db.prepare(
    `INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
     VALUES ('kid', '', ?, 999)`,
  ).run(forkSeq);
  child.forEach((w) => write({ ...w, branch: "kid" }));
  db.close();

  const space = openSpace(path);
  try {
    run(space);
  } finally {
    space.close();
    await Deno.remove(dir, { recursive: true });
  }
}

/** Two writers on `of:shared`, two on `of:quiet`, both inherited by `kid`. */
const CONTENDED_PARENT: Write[] = [
  { id: "of:shared", session: ALICE, value: "p1" },
  { id: "of:shared", session: BOB, value: "p2" },
  { id: "of:shared", session: ALICE, value: "p3" },
  { id: "of:quiet", session: ALICE, value: "q1" },
  { id: "of:quiet", session: BOB, value: "q2" },
];

describe("branch-visible", () => {
  describe("entityHistory()", () => {
    it("returns the parent's writes for an entity the child inherited", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        // The entity reads fine from `kid`, so an empty log would be a false
        // statement about it rather than a gap the caller could notice.
        expect(reconstructDocument(space, { id: "of:shared", branch: "kid" }))
          .toEqual({ value: "p3" });
        expect(
          entityHistory(space, { id: "of:shared", branch: "kid" })
            .map((w) => w.seq),
        ).toEqual([1, 2, 3]);
      });
    });

    it("returns only the child's writes for an entity the child overrode", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        // The child's write is the visible row, and the value came from it
        // alone — `reconstructWithinBranch` never composes across the fork — so
        // the parent's two writes are not this entity's history from here.
        expect(reconstructDocument(space, { id: "of:quiet", branch: "kid" }))
          .toEqual({ value: "child" });
        expect(
          entityHistory(space, { id: "of:quiet", branch: "kid" })
            .map((w) => w.seq),
        ).toEqual([6]);
      });
    });

    it("returns nothing for an entity the branch cannot see", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(entityHistory(space, { id: "of:absent", branch: "kid" }))
          .toEqual([]);
      });
    });
  });

  describe("entityTimeline()", () => {
    it("replays the writes of the branch that owns the visible row", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(
          entityTimeline(space, { id: "of:shared", branch: "kid" })
            .map((s) => s.seq),
        ).toEqual([1, 2, 3]);
      });
    });

    it("replays only the child's writes for an entity it overrode", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        expect(
          entityTimeline(space, { id: "of:quiet", branch: "kid" })
            .map((s) => s.seq),
        ).toEqual([6]);
      });
    });
  });

  describe("hotEntities()", () => {
    it("ranks the entities a child inherited alongside its own", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:kidonly", value: "k" },
      ], (space) => {
        expect(
          hotEntities(space, { branch: "kid" }).map((e) =>
            `${e.id}:${e.writes}`
          ),
        ).toEqual(["of:shared:3", "of:quiet:2", "of:kidonly:1"]);
      });
    });

    it("counts an overridden entity on the branch that overrode it", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        const quiet = hotEntities(space, { branch: "kid" })
          .find((e) => e.id === "of:quiet");
        expect(quiet?.writes).toBe(1);
      });
    });
  });

  describe("contendedEntities()", () => {
    it("reports contention inherited from the parent", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        // Local rows only would report NO contention on this branch, over two
        // entities it can read that each carry two writers.
        expect(
          contendedEntities(space, { branch: "kid" }).map((e) =>
            `${e.id}:${e.sessions}`
          ),
        ).toEqual(["of:shared:2", "of:quiet:2"]);
      });
    });

    it("drops an entity whose override left it with one writer", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        expect(
          contendedEntities(space, { branch: "kid" }).map((e) => e.id),
        ).toEqual(["of:shared"]);
      });
    });
  });

  describe("analyzeSpaceSignals()", () => {
    it("detects a home the child branch inherited", async () => {
      const home = {
        $NAME: "Home",
        createProfile: { "/": { id: "of:cp" } },
        profiles: [],
      };
      await withFork([{ id: "of:home", value: home }], [], (space) => {
        // Assert the parent detects it FIRST: without that, "the branches
        // agree" is satisfied by both saying false, and the test could not
        // fail.
        expect(analyzeSpaceSignals(space).isHome).toBe(true);
        expect(analyzeSpaceSignals(space, { branch: "kid" }).isHome).toBe(true);
      });
    });
  });

  describe("spaceTimeline()", () => {
    it("stays local, because a branch's activity is not its inherited entities", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:kidonly", value: "k" },
      ], (space) => {
        // Deliberate, and the counterpart to everything above: this describes
        // the commits made ON the branch. Inherited entities were created by
        // commits that are not in this timeline, so folding them in would
        // attribute creations to commits it never lists.
        expect(
          spaceTimeline(space, { branch: "kid" }).map((t) => t.commitSeq),
        ).toEqual([6]);
      });
    });
  });
});
