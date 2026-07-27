// `cf space` end to end through the real CLI process: the rehearsal loop an
// operator actually runs (clone → attempt → verify → reset → verify) plus the
// two things a script depends on — a nonzero exit when content moved, and a
// refusal to write into the live store.
//
// The library's semantics are covered in packages/state-inspector/test/; this
// suite guards the command surface and its exit codes.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { cf, withEnv } from "./utils.ts";

/** `CliResult` streams are line arrays; join before substring assertions. */
const text = (lines: string[]): string => lines.join("\n");

const SPACE = "did:key:z6MkCliCloneTest";
const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

/** A source snapshot with one piece, one authored cell, one generated cell. */
function seedSnapshot(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
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
);`);
  appendDocs(db, [
    ["of:piece", {
      value: { $NAME: "Board" },
      argument: link("of:input"),
      internal: [
        { partialCause: "entries", link: link("of:named") },
        { partialCause: { $generated: 0 }, link: link("of:generated") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }],
    ["of:input", { value: { title: "a topic" } }],
    ["of:named", { value: "named-v1", result: link("of:piece") }],
    ["of:generated", { value: "generated-v1", result: link("of:piece") }],
  ]);
  db.close();
}

function appendDocs(db: Database, docs: [string, unknown][]): void {
  const base = db.prepare(`SELECT coalesce(max(seq), 0) s FROM "commit"`)
    .get<{ s: number }>()!.s;
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, 'space', ?, 0, 'set', ?, ?)`,
  );
  docs.forEach(([id, doc], i) => {
    const seq = base + i + 1;
    commit.run(seq, SESSION, seq);
    rev.run(id, seq, JSON.stringify(doc), seq);
  });
}

/** Apply writes to the clone's working copy, as a rehearsal attempt would. */
function writeToWorkingCopy(dir: string, docs: [string, unknown][]): void {
  const db = new Database(`${dir}/engine-v3/${SPACE}.sqlite`);
  appendDocs(db, docs);
  db.close();
}

async function withFixture(
  run: (t: { snapshot: string; clone: string; root: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "cf-space-test-" });
  try {
    const snapshotDir = `${root}/snapshot`;
    await Deno.mkdir(snapshotDir);
    const snapshot = `${snapshotDir}/${SPACE}.sqlite`;
    seedSnapshot(snapshot);
    await run({ snapshot, clone: `${root}/clone`, root });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

describe("cf space", () => {
  it("runs the rehearsal loop: clone, attempt, verify, reset", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      const cloned = await cf(
        `space clone ${SPACE} --from ${snapshot} --to ${clone}`,
      );
      expect(cloned.code).toBe(0);
      // The working copy lands where the memory server resolves a space store,
      // so MEMORY_DIR can serve the clone under the same DID.
      expect(text(cloned.stdout)).toContain(`engine-v3/${SPACE}.sqlite`);
      expect(text(cloned.stdout)).toContain("1 generated cells excluded");

      const clean = await cf(`space verify ${clone}`);
      expect(clean.code).toBe(0);
      expect(text(clean.stdout)).toContain("content    unchanged");

      // A rehearsal attempt that damages authored content.
      writeToWorkingCopy(clone, [["of:input", {
        value: { title: "CLOBBERED" },
      }]]);

      const damaged = await cf(`space verify ${clone}`);
      expect(damaged.code).toBe(1);
      expect(text(damaged.stdout)).toContain("content    CHANGED");

      const reset = await cf(`space reset ${clone}`);
      expect(reset.code).toBe(0);
      expect(text(reset.stdout)).toContain("matches baseline");

      const recovered = await cf(`space verify ${clone}`);
      expect(recovered.code).toBe(0);
    });
  });

  it("passes verification when only generated cells were rewritten", async () => {
    // A clean pattern update rotates generated cells and adds commits. If that
    // failed verification, every legitimate migration would look like data loss.
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      writeToWorkingCopy(clone, [
        ["of:generated", { value: "generated-v2", result: link("of:piece") }],
      ]);

      const result = await cf(`space verify ${clone}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("content    unchanged");
      // ...and the growth is still reported, not hidden.
      expect(text(result.stdout)).toContain("commits    4 → 5");
    });
  });

  it("refuses to write a clone into the live store directory", async () => {
    await withFixture(async ({ snapshot, root }) => {
      const live = `${root}/live-memory`;
      await Deno.mkdir(live);
      // The CLI subprocess inherits this env, which is how it learns what the
      // local server is serving.
      await withEnv("MEMORY_DIR", `file://${live}/`, async () => {
        const result = await cf(
          `space clone ${SPACE} --from ${snapshot} --to ${live}/clone`,
        );
        expect(result.code).not.toBe(0);
        expect(text(result.stderr)).toContain(
          "overlaps the live store directory",
        );
        expect(await exists(`${live}/clone`)).toBe(false);
      });
    });
  });

  it("reports a fingerprint that ignores generated-cell churn", async () => {
    await withFixture(async ({ snapshot, clone }) => {
      await cf(`space clone ${SPACE} --from ${snapshot} --to ${clone}`);
      const working = `${clone}/engine-v3/${SPACE}.sqlite`;

      const before = await cf(`space fingerprint ${working}`);
      expect(before.code).toBe(0);
      expect(text(before.stdout)).toContain("3 entities fingerprinted");

      writeToWorkingCopy(clone, [
        ["of:generated", { value: "generated-v2", result: link("of:piece") }],
      ]);
      const after = await cf(`space fingerprint ${working}`);
      expect(after.stdout[0]).toBe(before.stdout[0]);

      // --include-generated deliberately inverts that.
      const loose = await cf(
        `space fingerprint ${working} --include-generated`,
      );
      expect(loose.stdout[0]).not.toBe(before.stdout[0]);
    });
  });

  it("rejects a directory that is not a clone", async () => {
    await withFixture(async ({ root }) => {
      const result = await cf(`space verify ${root}`);
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain("is not a clone directory");
    });
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
