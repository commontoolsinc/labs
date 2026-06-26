// Hermetic test for cross-space convergence. Builds several tiny space DBs in a
// temp dir holding the SAME entity id with converged / diverged / partial state,
// then checks the verdicts. Side-effect free.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { convergence, convergenceScan, openSpaces } from "../multispace.ts";

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
`;

// Write a single set of an entity's value into a fresh space DB.
function makeSpace(path: string, entries: { id: string; value: unknown }[]) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  entries.forEach((e, i) => {
    const seq = i + 1;
    commit.run(seq, `session-${i}`, 1, JSON.stringify({ seq }));
    rev.run(e.id, seq, JSON.stringify({ value: e.value }), seq);
  });
  db.close();
}

Deno.test("cross-space convergence", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-converge-" });
  try {
    // X agrees in A & B, disagrees in C; Y is present only in A & B (partial); Z only in A.
    makeSpace(`${dir}/A.sqlite`, [
      { id: "of:X", value: { n: 1 } },
      { id: "of:Y", value: { ok: true } },
      { id: "of:Z", value: { solo: 1 } },
    ]);
    makeSpace(`${dir}/B.sqlite`, [
      { id: "of:X", value: { n: 1 } },
      { id: "of:Y", value: { ok: true } },
    ]);
    makeSpace(`${dir}/C.sqlite`, [
      { id: "of:X", value: { n: 999 } },
    ]);

    const refs = openSpaces([`${dir}/A.sqlite`, `${dir}/B.sqlite`, `${dir}/C.sqlite`]);
    try {
      await t.step("diverged: X differs in C", () => {
        const r = convergence(refs, { id: "of:X" });
        assertEquals(r.verdict, "diverged");
        assertEquals(r.clusters.length, 2);
        // the {n:1} cluster holds A and B
        const big = r.clusters.find((c) => c.labels.length === 2);
        assertEquals(big?.labels.sort(), ["A.sqlite", "B.sqlite"]);
      });

      await t.step("partial: Y present in A,B but absent in C", () => {
        const r = convergence(refs, { id: "of:Y" });
        assertEquals(r.verdict, "partial");
        assertEquals(r.views.filter((v) => v.present).length, 2);
        assertEquals(r.views.find((v) => v.label === "C.sqlite")?.present, false);
      });

      await t.step("absent: unknown entity", () => {
        assertEquals(convergence(refs, { id: "of:nope" }).verdict, "absent");
      });

      await t.step("path-scoped convergence", () => {
        // X.n converges to 1 across A,B; C diverges at 999
        const r = convergence(refs, { id: "of:X", path: ["n"] });
        assertEquals(r.verdict, "diverged");
        const c = r.views.find((v) => v.label === "C.sqlite");
        assertEquals(c?.value, 999);
      });

      await t.step("scan surfaces X (diverged) and Y (partial), not Z", () => {
        const scan = convergenceScan(refs);
        const ids = scan.findings.map((f) => f.id).sort();
        assertEquals(ids, ["of:X", "of:Y"]);
        // Z is solo (present in only one space) → not a shared entity
        assert(!ids.includes("of:Z"));
      });
    } finally {
      for (const r of refs) r.space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
