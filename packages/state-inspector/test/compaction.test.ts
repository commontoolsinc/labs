// Verification of a compacted store against its backup: passes on what the
// run produces, and names the property a tampered result lost.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { compactStore } from "@commonfabric/memory/v2/compact";

import {
  type CompactionVerification,
  formatCompactionVerification,
  verifyCompaction,
} from "../compaction.ts";

const SPACE = "did:key:z6MkTestSpace";
const ACL = `of:${SPACE}`;

const commit = (localSeq: number, operations: unknown[]) =>
  ({ localSeq, reads: { confirmed: [], pending: [] }, operations }) as never;

/** A store with an ACL genesis, two computed instances with long histories,
 * one authored document, and a per-user instance. */
async function buildStore(
  path: string,
  withAcl = true,
  deleteAcl = false,
): Promise<void> {
  const engine = await open({ url: toFileUrl(path), snapshotInterval: 5 });
  let local = 1;
  const apply = (operations: unknown[]) =>
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(local++, operations),
    });
  if (withAcl) {
    applyCommit(engine, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      commit: commit(1, [{
        op: "set",
        id: ACL,
        value: { value: { [SPACE]: "OWNER" } },
      }]),
    } as never);
  }
  for (const id of ["computed:a", "computed:b"]) {
    apply([{ op: "set", id, value: { value: { n: 0, items: [] } } }]);
    for (let index = 1; index <= 12; index++) {
      apply([{
        op: "patch",
        id,
        patches: [
          { op: "replace", path: "/value/n", value: index },
          { op: "add", path: "/value/items/-", value: `item ${index}` },
        ],
      }]);
    }
  }
  if (withAcl && deleteAcl) {
    applyCommit(engine, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      commit: commit(2, [{ op: "delete", id: ACL }]),
    } as never);
  }
  // An unselected authored document with enough patches for a snapshot of
  // its own, which the run must leave alone.
  apply([{ op: "set", id: "of:topic", value: { value: { title: "kept" } } }]);
  for (let edit = 1; edit <= 6; edit++) {
    apply([{
      op: "patch",
      id: "of:topic",
      patches: [{
        op: "replace",
        path: "/value/title",
        value: `kept, edit ${edit}`,
      }],
    }]);
  }
  // What I7 keeps: a blob, and a table a pattern made through the builtin.
  engine.database.exec(
    `INSERT INTO blob_store (hash, data, content_type, size) VALUES ('h1', X'0102', 'application/octet-stream', 2);
     CREATE TABLE "pattern notes" (k TEXT, v TEXT);
     INSERT INTO "pattern notes" VALUES ('a', '1'), ('a', '1'), ('b', '2');`,
  );
  applyCommit(engine, {
    sessionId: "s:a",
    principal: "did:key:zAlice",
    commit: commit(local++, [{
      op: "set",
      id: "computed:a",
      scope: "user",
      value: { value: { n: 99 } },
    }]),
  } as never);
  close(engine);
}

const failing = (verification: CompactionVerification): string[] =>
  verification.checks.filter((check) => !check.passed).map((check) =>
    check.name
  );

async function withCompacted(
  run: (
    t: { backup: string; result: string; dir: string },
  ) => void | Promise<void>,
  options: {
    withAcl?: boolean;
    deleteAcl?: boolean;
    keepPayloadsMs?: number;
    keepLast?: number;
    twice?: boolean;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "compaction-verify-" });
  try {
    const store = `${dir}/work.sqlite`;
    const backup = `${dir}/backup.sqlite`;
    const result = `${dir}/result.sqlite`;
    await buildStore(store, options.withAcl ?? true, options.deleteAcl);
    await Deno.copyFile(store, backup);
    await compactStore({
      store,
      out: result,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: options.keepPayloadsMs ?? 0,
      ...(options.keepLast === undefined
        ? {}
        : { cut: { keepLast: options.keepLast } }),
      runId: "first",
    });
    if (options.twice) {
      // A second run over the first's output, against that output as its
      // backup: an earlier run's markers are in both files.
      await Deno.copyFile(result, `${dir}/second-backup.sqlite`);
      await Deno.copyFile(result, `${dir}/second-work.sqlite`);
      await compactStore({
        store: `${dir}/second-work.sqlite`,
        out: `${dir}/second-result.sqlite`,
        selection: { prefixes: ["computed:", "of:"] },
        keepPayloadsMs: 0,
        runId: "second",
      });
      await run({
        backup: `${dir}/second-backup.sqlite`,
        result: `${dir}/second-result.sqlite`,
        dir,
      });
      return;
    }
    await run({ backup, result, dir });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("verifyCompaction passes on the run's own output, in full and sampled", async () => {
  await withCompacted(({ backup, result }) => {
    const full = verifyCompaction({ result, against: backup });
    assertEquals(failing(full), []);
    assert(full.ok);
    assertEquals(full.compactionCommits.length, 1);
    assert(full.compactionCommits[0].report !== undefined);
    const names = full.checks.map((check) => check.name);
    assert(names.includes("fingerprint"));
    assert(names.includes("the run did what it planned"));
    const text = formatCompactionVerification(full);
    assert(text.startsWith("ok  "));
    assert(
      text.endsWith(`checks passed in ${(full.elapsedMs / 1000).toFixed(1)} s`),
    );
    const compared = full.checks.find((check) =>
      check.name === "every document reads back identical"
    )!;
    assert(
      compared.detail.startsWith("4 of 4 instance(s) compared"),
      compared.detail,
    );

    const sampled = verifyCompaction({ result, against: backup, sample: 2 });
    assertEquals(failing(sampled), []);
    assertFalse(sampled.checks.some((check) => check.name === "fingerprint"));
    const sampledDocs = sampled.checks.find((check) =>
      check.name === "every document reads back identical"
    )!.detail;
    assert(
      sampledDocs.startsWith("2 of 4 instance(s) compared (every 2th)"),
      sampledDocs,
    );
    // `sample: 1` is every document, with only the fingerprint skipped.
    const everyOne = verifyCompaction({ result, against: backup, sample: 1 });
    assertEquals(failing(everyOne), []);
    assert(
      everyOne.checks.find((check) =>
        check.name === "every document reads back identical"
      )!.detail.startsWith("4 of 4"),
    );
    assertFalse(everyOne.checks.some((check) =>
      check.name === "fingerprint"
    ));
    const payloads = full.checks.find((check) =>
      check.name === "hollowed payloads"
    )!;
    assert(/^(\d+) hollowed; \1 marker/.test(payloads.detail), payloads.detail);
    assert(names.includes("tables outside the history are untouched"));
    assert(
      names.includes(
        "materialized boundaries hold the backup's state at their row",
      ),
    );
  });
});

Deno.test("verifyCompaction passes when the space has no ACL document", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(failing(verification), []);
    assertEquals(
      verification.checks.find((check) => check.name === "ACL document")!
        .detail,
      "the space has no ACL document; none was written",
    );
  }, { withAcl: false });
});

Deno.test("verifyCompaction passes when the ACL document is a tombstone the run left alone, and catches it moved", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(failing(verification), []);
    const detail = verification.checks.find((check) =>
      check.name === "ACL document"
    )!.detail;
    assert(detail.startsWith("tombstone in the backup at "), detail);
    // The tombstone's head moved back to the genesis set: the engine would
    // read the old owner ACL again.
    const copy = `${dir}/resurrected.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    db.exec(
      `UPDATE head SET seq = 1, op_index = 0, op = 'set' WHERE id = '${ACL}'`,
    );
    db.close();
    const moved = verifyCompaction({ result: copy, against: backup });
    assert(
      failing(moved).includes("ACL document"),
      formatCompactionVerification(moved),
    );
  }, { deleteAcl: true });
});

Deno.test("verifyCompaction passes on a second run whose backup already holds markers", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(
      failing(verification),
      [],
      formatCompactionVerification(verification),
    );
    assertEquals(verification.compactionCommits.length, 2);
    const acl = verification.checks.find((check) =>
      check.name === "ACL document"
    )!;
    assert(acl.detail.includes("2 audit revision(s) for 2 run(s)"), acl.detail);
  }, { twice: true });
});

Deno.test("verifyCompaction catches a materialized boundary holding the wrong state under a bounded cut", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const clean = verifyCompaction({ result, against: backup });
    assertEquals(failing(clean), [], formatCompactionVerification(clean));
    // The boundary is a kept patch materialized mid-history; later retained
    // patches set `n` again, so the head still reads right whatever the
    // boundary holds. Only the exact-row comparison sees it.
    const copy = `${dir}/boundary.sqlite`;
    await Deno.copyFile(result, copy);
    const db = new Database(copy);
    const boundary = db.prepare(
      `SELECT seq, op_index FROM revision WHERE id = 'computed:a' AND scope_key = 'space' AND op = 'set' ORDER BY seq LIMIT 1`,
    ).get<{ seq: number; op_index: number }>()!;
    db.prepare(
      `UPDATE revision SET data = replace(data, '"n":', '"n":99') WHERE id = 'computed:a' AND scope_key = 'space' AND seq = ? AND op_index = ?`,
    ).run(boundary.seq, boundary.op_index);
    db.close();
    const verification = verifyCompaction({ result: copy, against: backup });
    assertEquals(failing(verification), [
      "materialized boundaries hold the backup's state at their row",
    ]);
  }, { keepLast: 6 });
});

Deno.test("verifyCompaction names what a tampered result lost", async () => {
  await withCompacted(async ({ backup, result, dir }) => {
    const tampered = async (
      sql: string,
      ...expected: string[]
    ): Promise<CompactionVerification> => {
      const copy = `${dir}/tampered.sqlite`;
      await Deno.copyFile(result, copy);
      const db = new Database(copy);
      db.prepare(`ATTACH DATABASE ? AS against`).run(backup);
      db.exec(sql);
      db.close();
      const verification = verifyCompaction({ result: copy, against: backup });
      assertFalse(verification.ok, sql);
      for (const name of expected) {
        assert(
          failing(verification).includes(name),
          `${sql}\n${formatCompactionVerification(verification)}`,
        );
      }
      await Deno.remove(copy);
      return verification;
    };

    // A materialized boundary holding the wrong document.
    await tampered(
      `UPDATE revision SET data = replace(data, '"n":12', '"n":13') WHERE id = 'computed:a' AND scope_key = 'space' AND op = 'set'`,
      "every document reads back identical",
      "fingerprint",
    );
    // Every document differs: the list of them is capped at five.
    const many = await tampered(
      `UPDATE revision SET data = replace(data, '"n":', '"m":') WHERE op = 'set' AND id NOT LIKE 'of:did:%'`,
      "every document reads back identical",
    );
    const differ = many.checks.find((check) =>
      check.name === "every document reads back identical"
    )!.detail;
    assert(differ.includes("differ or unreadable: "), differ);
    assert(differ.split(", ").length <= 6, differ);
    // A head moved.
    await tampered(
      `UPDATE head SET seq = seq + 1 WHERE id = 'of:topic'`,
      "heads keep their addresses",
      "every head has its revision row",
    );
    // An untouched instance's row altered.
    await tampered(
      `UPDATE revision SET data = '[]' WHERE id = 'of:topic' AND op = 'patch'`,
      "rows above the boundaries are byte-identical",
    );
    // A row deleted from the middle of a surviving history: a hole.
    await tampered(
      `DELETE FROM revision WHERE id = 'of:topic' AND op = 'set'`,
      "deleted rows lie below a boundary and above no surviving row",
    );
    // Live data outside the history lost: a blob row, a pattern's table
    // dropped, a duplicate row removed from a table without a key.
    await tampered(
      `DELETE FROM blob_store`,
      "tables outside the history are untouched",
    );
    await tampered(
      `DROP TABLE "pattern notes"`,
      "schema identical",
      "tables outside the history are untouched",
    );
    await tampered(
      `DELETE FROM "pattern notes" WHERE rowid = (SELECT MIN(rowid) FROM "pattern notes" WHERE k = 'a')`,
      "tables outside the history are untouched",
    );
    // An eligible payload kept intact.
    await tampered(
      `UPDATE "commit" SET original = (SELECT original FROM against."commit" WHERE seq = 3) WHERE seq = 3`,
      "hollowed payloads",
    );
    // A marker whose hash is wrong, wherever it sits.
    await tampered(
      `UPDATE "commit" SET original = replace(original, '"hash":"', '"hash":"x') WHERE seq = (SELECT MAX(seq) FROM "commit" WHERE original LIKE 'fvj1:{"hollowed":%')`,
      "hollowed payloads",
    );
    // A marker that does not decode.
    await tampered(
      `UPDATE "commit" SET original = substr(original, 1, length(original) - 3) WHERE seq = 3`,
      "hollowed payloads",
    );
    // Commit metadata changed; a compaction commit's local_seq changed; a
    // run's plan replaced by something that is not one.
    await tampered(
      `UPDATE "commit" SET created_at = '1900-01-01 00:00:00' WHERE seq = 2`,
      "every commit row survives; only payloads go",
    );
    await tampered(
      `UPDATE "commit" SET local_seq = 9 WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    await tampered(
      `UPDATE "commit" SET original = 'fvj1:{"compaction":{"report":{}}}' WHERE session_id LIKE 'compaction:%'`,
      "compaction commit recorded",
    );
    // A retained snapshot of an untouched instance removed.
    await tampered(
      `DELETE FROM snapshot WHERE id = 'of:topic'`,
      "snapshots are the backup's, removed only at or below a boundary",
    );
    // The genesis receipt hollowed by hand.
    await tampered(
      `UPDATE "commit" SET original = (SELECT original FROM "commit" WHERE seq = 3) WHERE seq = 1`,
      "hollowed payloads",
      "genesis receipt byte-identical",
    );
    // A commit row dropped.
    await tampered(
      `PRAGMA foreign_keys = OFF; DELETE FROM "commit" WHERE seq = 4`,
      "every commit row survives; only payloads go",
    );
    // A write after the compaction commit.
    await tampered(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       SELECT seq + 1, 'late', 1, original, resolution FROM "commit" WHERE seq = (SELECT MAX(seq) FROM "commit")`,
      "no commit after the compaction commit",
    );
    // The ACL marker stripped.
    await tampered(
      `DELETE FROM revision WHERE id = '${ACL}' AND seq = (SELECT MAX(seq) FROM "commit");
       UPDATE head SET seq = 1, op_index = 0, op = 'set' WHERE id = '${ACL}'`,
      "ACL document",
    );
    // No compaction commit at all: the backup against itself.
    const none = verifyCompaction({ result: backup, against: backup });
    assertFalse(none.ok);
    assertEquals(failing(none), ["compaction commit recorded"]);
  });
});
