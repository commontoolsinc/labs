// CLI dispatch test: drives `main(argv)` over a seeded DB and asserts the
// single-space commands return success and emit parseable `--json`. Also guards
// the flag-parsing fix — a boolean flag (`--json`) before the <db> positional
// must not swallow the path.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { main } from "../cli.ts";

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
INSERT INTO branch (name, head_seq, status) VALUES ('', 2, 'active');
`;

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{"reads":{"confirmed":[],"pending":[]}}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );
  commit.run(1, 1);
  rev.run("of:a", 1, "set", JSON.stringify({ value: { n: 1 } }), 1);
  commit.run(2, 2);
  rev.run(
    "of:a",
    2,
    "patch",
    JSON.stringify([{ op: "replace", path: "/value/n", value: 2 }]),
    2,
  );
  db.close();
}

/** Run `main` while capturing stdout lines. */
function run(argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const code = main(argv);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

Deno.test("cli: single-space commands dispatch over a seeded DB", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-cli-" });
  const db = `${dir}/space.sqlite`;
  try {
    seed(db);

    await t.step("summary --json returns structured output", () => {
      const { code, out } = run(["summary", db, "--json"]);
      assertEquals(code, 0);
      const s = JSON.parse(out);
      assertEquals(s.entities, 1);
      assertEquals(s.commits, 2);
    });

    await t.step("--json BEFORE <db> still works (flag-order fix)", () => {
      const { code, out } = run(["summary", "--json", db]);
      assertEquals(code, 0);
      assert(JSON.parse(out).entities === 1, "db path not swallowed by --json");
    });

    await t.step("value-at reconstructs the latest value", () => {
      const { code, out } = run(["value-at", db, "of:a", "--json"]);
      assertEquals(code, 0);
      const r = JSON.parse(out);
      // the patch took n to 2
      assertEquals((r.value as { n: number }).n, 2);
    });

    await t.step("hot + history + commits succeed", () => {
      for (
        const argv of [["hot", db], ["history", db, "of:a"], ["commits", db]]
      ) {
        assertEquals(run([...argv, "--json"]).code, 0, argv.join(" "));
      }
    });

    await t.step("missing <db> is a usage error (exit 1)", () => {
      assertEquals(run(["summary"]).code, 1);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
