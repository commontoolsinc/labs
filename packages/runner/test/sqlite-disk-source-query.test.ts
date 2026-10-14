// Phase 7 (runner seam): the Runtime storage provider exposes the
// `registerSqliteDiskSource` passthrough, and a write to a registered injected
// on-disk source is rejected (read-only v1) — through the runner provider, not
// just the raw server.
//
// Reading ROWS from a seeded on-disk file end to end (register -> query ->
// rows, and the unregistered cell-db fallback) is proven against the real
// client/server transport in packages/memory/test/v2-sqlite-disk-source.test.ts
// (loopback), and labeling such a read through a pattern input is proven in
// this package's integration lane (integration/sqlite-cfc-label-injected.test.ts).
// Both seed a real file with `@db/sqlite`; this UNIT lane does not, and proves
// only the runner-specific delta: the provider delegates register/execute to
// the session, the server's read-only rejection for a registered id surfaces
// back through the runner, and a handle marked `external` reaches the server
// with its mark, so a query of one with no registration reports the source as
// unavailable. The write is rejected on `id` membership BEFORE any file
// attach, so no on-disk file is needed here.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
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
    // Register an injected source. Registration canonicalizes + requires the
    // path to exist, so use a real temp file (its contents don't matter — the
    // write is rejected on (space, id) membership before any attach).
    const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    try {
      await provider.registerSqliteDiskSource!(id, diskPath);

      // The write is rejected on the commit-fold path (the only write path): a
      // folded `sqlite` op against a registered injected source is refused
      // before any attach.
      const tx = runtime.edit();
      tx.recordSqliteWrite!(space, {
        op: "sqlite",
        db: { id, tables: {} },
        sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
      });
      const res = await tx.commit().settled;
      expect(res.error).toBeDefined();
    } finally {
      try {
        Deno.removeSync(diskPath);
      } catch { /* ignore */ }
    }
  });

  it("reports a handle marked external with no registration as unavailable, not empty", async () => {
    // The mark travels with the handle to the server, which fails the read
    // rather than falling back to a cell-derived database that would answer
    // with no rows.
    const { commonfabric } = createBuilder();
    const { pattern, sqliteQuery } = commonfabric;
    const db: SqliteDbRef = {
      id: `of:disk-${crypto.randomUUID()}`,
      tables: {},
      external: true,
    };
    const testPattern = pattern<Record<string, never>>(() =>
      // deno-lint-ignore no-explicit-any
      sqliteQuery({ db, sql: "SELECT 1 AS one" } as any)
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "sqlite-disk-source-unavailable",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit().settled;

    const settled = await waitForCellValue<
      { pending?: boolean; error?: string; result?: unknown }
    >(runtime, result, (value) => value?.pending === false);
    expect(settled.error).toContain("unavailable");
    expect(settled.result).toBeUndefined();
  });
});
