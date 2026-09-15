import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { createBuilder } from "../src/builder/factory.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending: boolean;
  result?: Array<{ id: number; body: string }>;
  error?: unknown;
  requestHash?: string;
};

/** One entity write the server was asked to commit: its op and the entity. */
type WrittenOp = { op: string; id: string };

describe("sqlite-query-row-identity", () => {
  // Every commit a runtime sends crosses the loopback transport as a frame the
  // server's own parser understands, so the frames are read there, ahead of
  // the server, and every `transact` frame's operations are kept in order.
  // That is the record the cases below measure the write-back against: which
  // entities a run wrote, and which of them nothing had written before.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let written: WrittenOp[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`rowid-${crypto.randomUUID()}`);
    space = signer.did();
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    written = [];
    const connect = server.connect.bind(server);
    server.connect = (send) => {
      const connection = connect(send);
      const receive = connection.receive.bind(connection);
      connection.receive = (payload: string) => {
        const message = MemoryV2Server.parseClientMessage(payload);
        if (message?.type === "transact") {
          for (const operation of message.commit.operations) {
            if ("id" in operation) {
              written.push({ op: operation.op, id: operation.id });
            }
          }
        }
        return receive(payload);
      };
      return connection;
    };
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  /** Runs one folded `sqlite` write against `db` through its own commit. */
  const execSqlite = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    const res = await tx.commit();
    if (res.error) throw res.error;
  };

  /**
   * A piece running one query over `notes`, re-issued whenever `tick`
   * changes. Returns the piece's result cell and the tick cell that drives
   * the re-run.
   */
  const runQuery = async (db: SqliteDbRef, label: string) => {
    const tx = runtime.edit();
    const tick = runtime.getCell<number>(space, `${label}-tick`, undefined, tx);
    tick.set(0);
    const queryPattern = cf.pattern<{ tick: number }>(({ tick }) =>
      cf.sqliteQuery({
        db,
        sql: "SELECT id, body FROM notes ORDER BY id",
        reactOn: tick,
        // The raw handle object stands in for a `sqliteDatabase` result here.
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const result = runtime.run(
      tx,
      queryPattern,
      { tick },
      runtime.getCell(space, `${label}-result`, queryPattern.resultSchema, tx),
    );
    await tx.commit();
    return { result, tick };
  };

  /** Waits for the query to settle under a request hash other than `after`. */
  const settledPast = (
    result: ReturnType<Runtime["getCell"]>,
    after: string | undefined,
  ) =>
    waitForCellValue<QueryState>(
      runtime,
      result,
      (v) => v?.pending === false && v.requestHash !== after,
    );

  /** Bumps `tick` so the query re-runs, and waits for that run to settle. */
  const rerun = async (
    result: ReturnType<Runtime["getCell"]>,
    tick: ReturnType<Runtime["getCell"]>,
    previous: QueryState,
  ): Promise<QueryState> => {
    const tx = runtime.edit();
    tick.withTx(tx).set((tick.withTx(tx).get() as number) + 1);
    await tx.commit();
    const state = await settledPast(result, previous.requestHash);
    await runtime.settled();
    return state;
  };

  /** The entity each stored result row links to, in row order. */
  const rowDocIds = (result: ReturnType<Runtime["getCell"]>): string[] => {
    const raw = result.key("result").getRaw() as unknown[];
    return raw.map((entry) => {
      const link = parseLink(entry as Parameters<typeof parseLink>[0], result);
      if (!link?.id) throw new Error("a result row is stored inline");
      return link.id;
    });
  };

  const seededDb = async (): Promise<SqliteDbRef> => {
    const db: SqliteDbRef = {
      id: `of:rowid-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    await execSqlite(
      db,
      "INSERT INTO notes (id, body) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    );
    return db;
  };

  it("re-runs over unchanged rows without minting or writing a row document", async () => {
    const db = await seededDb();
    const { result, tick } = await runQuery(db, "unchanged");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "b" },
      { id: 3, body: "c" },
    ]);
    const rowsBefore = rowDocIds(result);
    expect(rowsBefore).toHaveLength(3);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual(first.result);

    const secondRun = written.slice(mark);
    expect(rowDocIds(result)).toEqual(rowsBefore);
    expect(secondRun.filter((w) => rowsBefore.includes(w.id))).toEqual([]);
    expect(secondRun.filter((w) => !known.has(w.id))).toEqual([]);
  });

  it("writes only the changed row's document when one row changes", async () => {
    const db = await seededDb();
    const { result, tick } = await runQuery(db, "changed");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    const rowsBefore = rowDocIds(result);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    await execSqlite(db, "UPDATE notes SET body = 'B' WHERE id = 2");
    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "B" },
      { id: 3, body: "c" },
    ]);

    const rowsAfter = rowDocIds(result);
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter[1]).not.toBe(rowsBefore[1]);
    expect(rowsAfter[2]).toBe(rowsBefore[2]);
    const secondRun = written.slice(mark);
    const rowWrites = secondRun.filter((w) =>
      rowsBefore.includes(w.id) || rowsAfter.includes(w.id)
    );
    expect(rowWrites.map((w) => w.id)).toEqual([rowsAfter[1]]);
    expect(
      secondRun.filter((w) => !known.has(w.id) && w.id !== rowsAfter[1]),
    ).toEqual([]);
  });
});
