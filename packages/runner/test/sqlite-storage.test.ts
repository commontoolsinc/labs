// Runner-side integration: the storage provider exposes sqliteQuery/sqliteExecute
// that route through the emulated in-process memory server (same loopback path the
// real websocket uses). Proves the runner -> server SQLite path end to end.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { cfLink, table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("storage provider sqlite passthrough (emulated server)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  const dbRef = (): SqliteDbRef => ({
    id: `of:test-${crypto.randomUUID()}`,
    tables: {
      notes: table({ id: "integer primary key", body: "text" }),
      links: table({ id: "integer primary key", target_cf_link: cfLink() }),
    },
  });

  it("executes and queries through the provider", async () => {
    const provider = storageManager.open(space);
    const db = dbRef();

    const w = await provider.sqliteExecute!(
      db,
      "INSERT INTO notes (body) VALUES (?)",
      ["hello from runner"],
    );
    expect(w.changes).toBe(1);

    const r = await provider.sqliteQuery!(db, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hello from runner" }]);
  });

  it("propagates guard rejections as errors", async () => {
    const provider = storageManager.open(space);
    const db = dbRef();
    await expect(provider.sqliteQuery!(db, "SELECT * FROM commit")).rejects
      .toThrow();
    await expect(provider.sqliteExecute!(db, "DROP TABLE notes")).rejects
      .toThrow();
  });
});
