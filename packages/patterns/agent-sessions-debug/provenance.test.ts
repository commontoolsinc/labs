import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  entityHistory,
  getValueAt,
  openSpace,
  scopeOverlay,
} from "@commonfabric/state-inspector";
import {
  inspectLinkedValueCommand,
  inspectMaterializedValueCommand,
  inspectValueCommand,
} from "./provenance.ts";

const baseLink = {
  id: "of:session",
  space: "did:key:space",
  path: ["value", "details"],
};

Deno.test("space-scoped retrieval uses the default SQLite scope", () => {
  const command = inspectValueCommand({ ...baseLink, scope: "space" });

  assert(!command.includes("inspect overlay"));
  assert(!command.includes("--scope"));
  assert(command.includes(`--path-json '["value","details"]'`));
});

Deno.test("retrieval preserves every link path segment", () => {
  const command = inspectValueCommand({
    ...baseLink,
    path: ["a/b", "", 0],
  });
  assert(command.includes(`--path-json '["a/b","","0"]'`));

  const rootCommand = inspectValueCommand({ ...baseLink, path: [] });
  assert(!rootCommand.includes("--path-json"));
});

Deno.test("user-scoped retrieval discovers and uses the raw scope key", () => {
  const command = inspectValueCommand({ ...baseLink, scope: "user" });

  assert(command.includes("cf inspect overlay"));
  assert(command.includes("variants[]"));
  assert(command.includes("every candidate"));
  assert(command.includes("latest value"));
  assert(command.includes("user:${encodeURIComponent(PRINCIPAL_DID)}"));
  assertEquals(
    command.match(/--scope 'RAW_SCOPE_KEY'/g)?.length,
    2,
  );
  assert(!command.includes("--scope 'user'"));
});

Deno.test("session-scoped linked retrieval uses the raw scope key", () => {
  const command = inspectLinkedValueCommand(
    { ...baseLink, scope: "session" },
    "RECEIPT_REVISION_SEQ",
    "matches the raw page",
  );

  assert(command.includes("cf inspect overlay"));
  assert(
    command.includes(
      "session:${encodeURIComponent(PRINCIPAL_DID)}:${encodeURIComponent(SESSION_ID)}",
    ),
  );
  assert(command.includes("--scope 'RAW_SCOPE_KEY'"));
  assert(!command.includes("--scope 'session'"));
});

Deno.test("recursive retrieval distinguishes declared and raw scopes", () => {
  const command = inspectMaterializedValueCommand({
    ...baseLink,
    scope: "space",
  });

  assert(command.includes("containing declared scope"));
  assert(command.includes("variants[]"));
  assert(command.includes("latest"));
  assert(command.includes("--scope 'LINK_SCOPE_KEY'"));
  assert(!command.includes("--scope '<resolved $link.scope>'"));
});

const INSPECTOR_SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY,
  branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  local_seq INTEGER NOT NULL,
  invocation_ref TEXT,
  authorization_ref TEXT,
  original JSON NOT NULL,
  resolution JSON NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space',
  seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL,
  op TEXT NOT NULL,
  data JSON,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
`;

Deno.test("candidate histories recover a snapshot after every scope changes", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "agent-debug-provenance-",
  });
  const path = `${directory}/space.sqlite`;
  const entity = "of:session";
  const alice = "user:did%3Akey%3Aalice";
  const bob = "user:did%3Akey%3Abob";
  const database = new Database(path, { create: true });
  let databaseClosed = false;
  database.exec(INSPECTOR_SCHEMA);
  const put = (seq: number, scope: string, payload: string) => {
    database.prepare(
      `INSERT INTO "commit"
        (seq, branch, session_id, local_seq, original, resolution, created_at)
       VALUES (?, '', ?, ?, '{}', '{}', ?)`,
    ).run(seq, `session-${seq}`, seq, `2026-07-27T00:00:0${seq}.000Z`);
    database.prepare(
      `INSERT INTO revision
        (branch, id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES ('', ?, ?, ?, 0, 'set', ?, ?)`,
    ).run(
      entity,
      scope,
      seq,
      JSON.stringify({ value: { payload } }),
      seq,
    );
  };
  put(1, alice, "page snapshot");
  put(2, bob, "other snapshot");
  put(3, alice, "new Alice value");
  put(4, bob, "new Bob value");

  try {
    database.close();
    databaseClosed = true;
    const space = openSpace(path);
    try {
      const candidates = scopeOverlay(space, entity).variants.filter(
        (variant) => variant.kind === "user",
      );
      assertEquals(
        new Set(candidates.map((candidate) => candidate.scope)),
        new Set([alice, bob]),
      );
      assert(
        candidates.every((candidate) =>
          (candidate.value as { payload: string }).payload !== "page snapshot"
        ),
      );

      const matches = candidates.flatMap((candidate) =>
        entityHistory(space, {
          id: entity,
          scope: candidate.scope,
          limit: -1,
        }).flatMap((revision) =>
          getValueAt(
              space,
              {
                id: entity,
                scope: candidate.scope,
                atSeq: revision.seq,
              },
              ["payload"],
            ).value === "page snapshot"
            ? [{ scope: candidate.scope, seq: revision.seq }]
            : []
        )
      );
      assertEquals(matches, [{ scope: alice, seq: 1 }]);
    } finally {
      space.close();
    }
  } finally {
    if (!databaseClosed) database.close();
    await Deno.remove(directory, { recursive: true });
  }
});
