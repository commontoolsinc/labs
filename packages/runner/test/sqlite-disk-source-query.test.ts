// Phase 7 (runner seam): the Runtime storage provider exposes the
// `registerSqliteDiskSource` passthrough, and a write to a registered injected
// on-disk source is rejected (read-only v1) — through the runner provider, not
// just the raw server.
//
// Reading ROWS from a seeded on-disk file end to end (register -> query ->
// rows, and the unregistered cell-db fallback) is proven against the real
// client/server transport in packages/memory/test/v2-sqlite-disk-source-test.ts
// (loopback). That test owns the `@db/sqlite` file-seeding dependency; here we
// stay dependency-free and prove only the runner-specific delta: the provider
// delegates register/execute to the session, and the server's read-only
// rejection for a registered id surfaces back through the runner. The write is
// rejected on `id` membership BEFORE any file attach, so no on-disk file is
// needed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

describe("injected on-disk source via the runner storage provider", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`disksrc-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("exposes registerSqliteDiskSource on the provider", () => {
    const provider = storageManager.open(space);
    expect(typeof provider.registerSqliteDiskSource).toBe("function");
  });

  it("rejects a write to a registered injected source (read-only v1)", async () => {
    const id = `of:disk-${crypto.randomUUID()}`;
    const provider = storageManager.open(space);
    // Register an injected source (path need not exist — the write is rejected
    // on id membership before any attach).
    await provider.registerSqliteDiskSource!(id, "/tmp/does-not-matter.db");

    // The write is rejected on the commit-fold path (the only write path): a
    // folded `sqlite` op against a registered injected source is refused before
    // any attach.
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db: { id, tables: {} },
      sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
    });
    const res = await tx.commit();
    expect(res.error).toBeDefined();
  });
});
