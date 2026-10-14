// Phase 7 — injected on-disk SQLite source (read-only v1).
//
// Two seams proven here without the websocket:
//   1. read-only ATTACH: a seeded on-disk file is attached read-only; SELECT
//      returns its rows, but any write to the alias is rejected at the engine.
//   2. DiskSourceRegistry: register/get a `{ disk: { path } }` descriptor keyed
//      by the handle cell id.
//
// Spec: docs/specs/sqlite-builtin/03-database-sources.md §03.3; plan
// docs/specs/sqlite-builtin/plans/on-disk-source.md. Writes/reactivity for
// on-disk sources are deferred (Q12/Q13/Q14).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import { DiskSourceRegistry } from "../v2/sqlite/disk-source.ts";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import type {
  ResponseMessage,
  SqliteDbRef,
  SqliteQueryRequest,
  SqliteQueryWireResult,
} from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

function seedDiskDb(path: string): void {
  const seed = new Database(path);
  seed.exec("CREATE TABLE lookup (k TEXT, v TEXT)");
  seed.exec("INSERT INTO lookup (k, v) VALUES ('a', '1'), ('b', '2')");
  seed.close();
}

describe("ReadConnectionPool (read-only, unattached)", () => {
  let pool: ReadConnectionPool;
  let path: string;

  beforeEach(() => {
    pool = new ReadConnectionPool();
    path = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(path);
  });

  afterEach(() => {
    pool.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  });

  it("reads rows from the on-disk file on a pooled connection (reused)", () => {
    const rows = pool.query<{ v: string }>(
      path,
      "SELECT v FROM lookup ORDER BY k",
    );
    expect(rows).toEqual([{ v: "1" }, { v: "2" }]);
    // Same path → reuses the same pooled connection.
    const again = pool.query<{ v: string }>(path, "SELECT v FROM lookup");
    expect(again.length).toBe(2);
  });

  it("rejects a write through the pool (guard + read-only connection)", () => {
    expect(() => pool.query(path, "DELETE FROM lookup")).toThrow();
  });
});

describe("DiskSourceRegistry", () => {
  const SPACE_A = "did:key:z6Mk-a";
  const SPACE_B = "did:key:z6Mk-b";

  it("registers and resolves a disk descriptor by (space, id)", () => {
    const reg = new DiskSourceRegistry();
    expect(reg.get(SPACE_A, "of:bafy123")).toBeUndefined();
    reg.register(SPACE_A, "of:bafy123", { path: "/abs/reference-data.db" });
    expect(reg.get(SPACE_A, "of:bafy123")).toEqual({
      path: "/abs/reference-data.db",
    });
  });

  it("is keyed by space — a registration does not leak across spaces", () => {
    const reg = new DiskSourceRegistry();
    reg.register(SPACE_A, "of:x", { path: "/abs/x.db" });
    expect(reg.has(SPACE_A, "of:x")).toBe(true);
    // Same id, different space → NOT registered (no cross-space hijack).
    expect(reg.has(SPACE_B, "of:x")).toBe(false);
    expect(reg.get(SPACE_B, "of:x")).toBeUndefined();
  });

  it("caps total entries (rejects new keys past the cap; re-register ok)", () => {
    const reg = new DiskSourceRegistry(2);
    reg.register(SPACE_A, "of:1", { path: "/a/1.db" });
    reg.register(SPACE_A, "of:2", { path: "/a/2.db" });
    // A NEW (space,id) past the cap is rejected.
    expect(() => reg.register(SPACE_A, "of:3", { path: "/a/3.db" })).toThrow(
      "registry is full",
    );
    // Re-registering an existing key is always allowed (idempotent), even full.
    expect(() => reg.register(SPACE_A, "of:1", { path: "/a/1b.db" })).not
      .toThrow();
    expect(reg.get(SPACE_A, "of:1")).toEqual({ path: "/a/1b.db" });
  });

  describe("with a file", () => {
    let dir: string;

    beforeEach(() => {
      dir = Deno.makeTempDirSync();
    });

    afterEach(() => {
      Deno.removeSync(dir, { recursive: true });
    });

    it("returns a registration another registry made with the same file", () => {
      const file = `${dir}/store/disk-sources.json`;
      new DiskSourceRegistry(4096, file).register(SPACE_A, "of:x", {
        path: "/abs/x.db",
      });
      const restarted = new DiskSourceRegistry(4096, file);
      expect(restarted.get(SPACE_A, "of:x")).toEqual({ path: "/abs/x.db" });
      expect(restarted.has(SPACE_B, "of:x")).toBe(false);
    });

    it("holds no registrations while the file does not exist", () => {
      const reg = new DiskSourceRegistry(4096, `${dir}/disk-sources.json`);
      expect(reg.has(SPACE_A, "of:x")).toBe(false);
    });

    it("throws when the file does not hold a list of registrations", () => {
      const file = `${dir}/disk-sources.json`;
      Deno.writeTextFileSync(file, JSON.stringify([{ space: SPACE_A }]));
      const reg = new DiskSourceRegistry(4096, file);
      expect(() => reg.has(SPACE_A, "of:x")).toThrow(
        "does not hold a list of registrations",
      );
    });
  });
});

const SPACE = "did:key:z6Mk-sqlite-disk-source-test";

describe("server attaches a registered on-disk source (read-only v1)", () => {
  let server: Server;
  let client: Awaited<ReturnType<typeof connect>>;
  // deno-lint-ignore no-explicit-any
  let session: any;
  let diskPath: string;
  let handleId: string;

  beforeEach(async () => {
    diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(diskPath);
    handleId = `of:disk-${crypto.randomUUID()}`;
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://sqlite-disk-source-test"),
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    try {
      Deno.removeSync(diskPath);
    } catch { /* ignore */ }
  });

  const dbRef = (): SqliteDbRef => ({ id: handleId });

  it("query reads rows from the registered on-disk file, not a cell-db", async () => {
    // No registration yet → falls back to the cell-derived db. It has never been
    // written, so there is no file and the read yields no rows (NOT the on-disk
    // file's rows).
    const before = await session.sqliteQuery(dbRef(), "SELECT v FROM lookup");
    expect(before.rows).toEqual([]);

    // Register the on-disk source for this handle id, then the same query
    // resolves against the on-disk file's rows.
    await session.registerSqliteDiskSource(handleId, diskPath);
    const r = await session.sqliteQuery(
      dbRef(),
      "SELECT v FROM lookup ORDER BY k",
    );
    expect(r.rows).toEqual([{ v: "1" }, { v: "2" }]);
  });

  it("rejects writes to an injected on-disk source (read-only v1)", async () => {
    await session.registerSqliteDiskSource(handleId, diskPath);
    // The only write path is the commit fold; a folded write to an injected
    // (read-only) source is rejected before any attach.
    await expect(
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "sqlite",
            db: dbRef(),
            sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
          },
        ],
      }),
    ).rejects.toThrow();
    // The on-disk file is unchanged.
    const r = await session.sqliteQuery(
      dbRef(),
      "SELECT count(*) AS n FROM lookup",
    );
    expect(r.rows).toEqual([{ n: 2 }]);
  });

  it("rejects a non-absolute or missing path at registration", async () => {
    await expect(session.registerSqliteDiskSource(handleId, "relative/x.db"))
      .rejects.toThrow();
    await expect(
      session.registerSqliteDiskSource(handleId, "/no/such/file/here.db"),
    ).rejects.toThrow();
  });

  it("does not leak a registration across spaces (C2)", async () => {
    const session2 = await client.mount(
      "did:key:z6Mk-sqlite-disk-source-test-2",
      {},
      testSessionOpenAuthFactory,
    );
    // Register the on-disk source under SPACE (session), NOT the second space.
    await session.registerSqliteDiskSource(handleId, diskPath);
    // The second space's read of the same handle id is not governed by SPACE's
    // registration → it falls through to its own (never-written, empty)
    // cell-derived db and yields NO rows — crucially, not the injected file's
    // rows. No cross-space read of the injected file.
    const r = await session2.sqliteQuery(dbRef(), "SELECT v FROM lookup");
    expect(r.rows).toEqual([]);
  });
});

/** What the first `sqliteQuery()` an {@link ObservedServer} ran was handed. */
type ObservedQuery = {
  /** The signal the connection passed with the read. */
  signal: AbortSignal | undefined;

  /** The response the server returned for the read. */
  response: Promise<ResponseMessage<SqliteQueryWireResult>>;
};

/** A `Server` that reports the first `sqliteQuery()` it runs. */
class ObservedServer extends Server {
  firstQuery = Promise.withResolvers<ObservedQuery>();

  override sqliteQuery(
    message: SqliteQueryRequest,
    options: { signal?: AbortSignal; requester?: string } = {},
  ): Promise<ResponseMessage<SqliteQueryWireResult>> {
    const response = super.sqliteQuery(message, options);
    this.firstQuery.resolve({ signal: options.signal, response });
    return response;
  }
}

describe("server reads an injected source off its event loop", () => {
  // The read here counts to fifty million in a recursive CTE, seconds of CPU
  // against the milliseconds the other client's request takes, and the
  // reading connection is closed once the other request has been answered.
  // Every assertion that turns on the read still running is made after
  // `firstQuery` reports that the server has begun it.

  const LONG_READ =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c " +
    "LIMIT 50000000) SELECT count(*) AS n FROM c";

  let server: ObservedServer;
  let client: Awaited<ReturnType<typeof connect>>;
  let diskPath: string;
  let handleId: string;

  beforeEach(() => {
    diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(diskPath);
    handleId = `of:disk-${crypto.randomUUID()}`;
    server = new ObservedServer({
      ...testSessionOpenServerOptions,
      store: new URL("memory://sqlite-disk-source-off-loop-test"),
    });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    Deno.removeSync(diskPath);
  });

  it("answers another client while it reads an injected source", async () => {
    client = await connect({ transport: loopback(server) });
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    await session.registerSqliteDiskSource(handleId, diskPath);
    const other = await connect({ transport: loopback(server) });
    try {
      const otherSession = await other.mount(
        "did:key:z6Mk-sqlite-disk-source-test-other",
        {},
        testSessionOpenAuthFactory,
      );

      let readSettled = false;
      const readEnded = session.sqliteQuery({ id: handleId }, LONG_READ)
        .then(() => "returned", () => "threw")
        .finally(() => readSettled = true);
      await server.firstQuery.promise;
      const answer = await otherSession.sqliteQuery(
        { id: "of:never-written" },
        "SELECT 1 AS one",
      );
      expect(answer.rows).toEqual([]);
      expect(readSettled).toBe(false);

      await client.close();
      expect(await readEnded).toBe("threw");
    } finally {
      await other.close();
    }
  });

  it("cancels the read when the reading connection closes", async () => {
    client = await connect({ transport: loopback(server) });
    const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    await session.registerSqliteDiskSource(handleId, diskPath);
    const readEnded = session.sqliteQuery({ id: handleId }, LONG_READ)
      .then(() => "returned", () => "threw");
    const { signal, response } = await server.firstQuery.promise;

    await client.close();
    expect(signal?.aborted).toBe(true);
    const answered = await response;
    expect(answered.ok).toBeUndefined();
    expect(answered.error?.name).toBe("AbortError");
    expect(await readEnded).toBe("threw");
  });
});

describe("server keeps an injected source's state across a restart", () => {
  // A file store keeps its registrations in the store directory, so a second
  // server over the same store reads them back. A handle marked `external`
  // names an injected source: a read with no registration behind it fails as
  // unavailable, and a write to it is refused, registered or not.

  let storeDir: string;
  let diskPath: string;
  let handleId: string;
  const servers: Server[] = [];
  const clients: Awaited<ReturnType<typeof connect>>[] = [];

  /** Starts a server over the shared file store and mounts `SPACE` on it. */
  async function start(store = new URL(`file://${storeDir}/`)) {
    const server = new Server({ ...testSessionOpenServerOptions, store });
    servers.push(server);
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    return {
      server,
      session: await client.mount(SPACE, {}, testSessionOpenAuthFactory),
    };
  }

  /** Closes every client and server `start()` opened. */
  async function stopAll() {
    for (const client of clients.splice(0)) await client.close();
    for (const server of servers.splice(0)) await server.close();
  }

  beforeEach(() => {
    storeDir = Deno.makeTempDirSync();
    diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(diskPath);
    handleId = `of:disk-${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    await stopAll();
    Deno.removeSync(storeDir, { recursive: true });
    try {
      Deno.removeSync(diskPath);
    } catch { /* a case removed it */ }
  });

  it("reads a registered source after a restart without registering it again", async () => {
    const first = await start();
    await first.session.registerSqliteDiskSource(handleId, diskPath);
    await stopAll();

    const { session } = await start();
    const { rows } = await session.sqliteQuery(
      { id: handleId, external: true },
      "SELECT v FROM lookup ORDER BY k",
    );
    expect(rows).toEqual([{ v: "1" }, { v: "2" }]);
  });

  it("fails a read of a handle marked external that has no registration", async () => {
    const { session } = await start();
    const error = await rejectionOf(
      session.sqliteQuery({ id: handleId, external: true }, "SELECT 1"),
    );
    expect(error.name).toBe("SqliteSourceUnavailable");
  });

  it("returns no rows for an unmarked handle whose cell-derived database was never written", async () => {
    const { session } = await start();
    const { rows } = await session.sqliteQuery({ id: handleId }, "SELECT 1");
    expect(rows).toEqual([]);
  });

  it("fails a read of a registered source whose file is gone after a restart", async () => {
    const first = await start();
    await first.session.registerSqliteDiskSource(handleId, diskPath);
    await stopAll();
    Deno.removeSync(diskPath);

    const { session } = await start();
    const error = await rejectionOf(
      session.sqliteQuery({ id: handleId, external: true }, "SELECT 1"),
    );
    expect(error.name).toBe("SqliteSourceUnavailable");
  });

  it("refuses a write to a handle marked external, registered or not", async () => {
    const { session } = await start();
    await expect(
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "sqlite",
          db: { id: handleId, external: true },
          sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
        }],
      }),
    ).rejects.toThrow("read-only");
  });

  it("refuses a write to a registered source after a restart", async () => {
    const first = await start();
    await first.session.registerSqliteDiskSource(handleId, diskPath);
    await stopAll();

    const { session } = await start();
    await expect(
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "sqlite",
          db: { id: handleId },
          sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
        }],
      }),
    ).rejects.toThrow("read-only");
  });
});

/** The error `promise` rejects with; fails the case when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-error: ${String(error)}`);
  }
  throw new Error("resolved, where a rejection was expected");
}
