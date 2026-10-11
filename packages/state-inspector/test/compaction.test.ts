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
  apply([{ op: "set", id: "of:topic", value: { value: { title: "kept" } } }]);
  apply([{
    op: "patch",
    id: "of:topic",
    patches: [{ op: "replace", path: "/value/title", value: "kept, edited" }],
  }]);
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
  options: { withAcl?: boolean; deleteAcl?: boolean; keepPayloadsMs?: number } =
    {},
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
    });
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
    assert(
      sampled.checks.find((check) =>
        check.name === "every document reads back identical"
      )!
        .detail.includes("(every 2th)"),
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

Deno.test("verifyCompaction passes when the ACL document is a tombstone the run left alone", async () => {
  await withCompacted(({ backup, result }) => {
    const verification = verifyCompaction({ result, against: backup });
    assertEquals(failing(verification), []);
    assertEquals(
      verification.checks.find((check) => check.name === "ACL document")!
        .detail,
      "the ACL document is deleted in the result and deleted in the backup",
    );
  }, { deleteAcl: true });
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
    assert(differ.includes("differ: "), differ);
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
