// Multi-runtime stability of the SqliteDb handle (CFC Phase 3 rule-bearing
// dbs). A rowLabel rule's term LIST (`all(a, b, …)` — an array of objects)
// used to split into per-element entity docs when the handle value was stored
// (Cell.set assigns [ID] to every object-in-array). Those term docs are not
// reachable through any schema-driven sync, so a SECOND runtime deep-resolved
// the links to `null` and `sqliteQuery` hashed `allOf: [null]` while the
// creator runtime hashed the resolved AST — two request hashes fighting over
// ONE shared (space-scoped) result cell, each runtime seeing the other's hash
// as "new inputs" and re-issuing forever (the query never settles).
//
// Guarded contract: the stored handle value is SELF-CONTAINED (no linked
// docs), so every runtime that can read the handle doc has the full resolved
// spec — one request hash per logical query, shared result-cell dedup works.
//
// The harness runs two real Runtimes with SEPARATE storage managers over one
// in-process memory server (separate heaps are the point: the bug only shows
// when a doc can exist server-side but not in the reading runtime's heap; the
// single-StorageManager emulate() setup would mask it).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SqliteTableSchemas } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForCellValue } from "./support/wait-for-cell-value.ts";
import { isSigilLink } from "../src/link-utils.ts";

// Fresh identity per RUN: the server derives the on-disk cell-db file from the
// (causal) db id, so a fixed passphrase would reuse a stale $TMPDIR db across
// test runs (the classic same-file repro trap).
const signer = await Identity.fromPassphrase(
  `sqlite handle multi runtime ${crypto.randomUUID()}`,
);
const space = signer.did();

// ---------------------------------------------------------------------------
// Two storage managers, ONE server — the emulated loopback session factory
// (mirrors v2-emulate.ts) against a caller-owned server, so each manager has
// its own heap/replica while sharing the durable state.
// ---------------------------------------------------------------------------

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class SharedServerStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    server: MemoryV2Server.Server,
  ): SharedServerStorageManager {
    return new SharedServerStorageManager(
      // Placeholder: the loopback session factory never resolves an address.
      { ...options, memoryHost: new URL("memory://") },
      new LoopbackSessionFactory(server),
    );
  }
}

function newServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-runner-shared-server-test",
    },
  });
}

// ---------------------------------------------------------------------------
// The pattern under test: a rule-bearing db whose rule is a term LIST
// (`all(sender, recipients)` — the mailbox shape), plus a shared query.
// Rebuilt per runtime (each has its own trusted builder); the causal ids
// derive from the shared result cell, so both runtimes address the same docs.
// ---------------------------------------------------------------------------

const RESULT_CAUSE = "sqlite-handle-multi-runtime";

// The tables flow through the pattern ARGUMENT (a real doc, like a compiled
// pattern's static data) rather than a builder literal: that is the shape
// where the handle write used to capture `tables` as a LINK into the pattern's
// doc graph — whose term-list splits a second runtime never loads.
function makeTables(
  cf: ReturnType<typeof createTrustedBuilder>["commonfabric"],
) {
  const { table, all, principal, match } = cf.cfSqlite;
  const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
  return {
    emails: table(
      {
        id: "integer primary key",
        from_addr: "text",
        to_addrs: "text",
      },
      (f) => ({
        confidentiality: all(
          principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
          principal("mailto", match(f.to_addrs, ADDR)),
        ),
      }),
    ),
    // Rule-less sibling: its INSERT creates the on-disk cell-db (a fresh,
    // never-written db reads back `{ rows: [] }` with NO column provenance,
    // which a rule-bearing read refuses fail-closed).
    notes: table({ id: "integer primary key", body: "text" }),
  };
}

/** Fold one INSERT into `notes` through db.exec so the cell-db file exists. */
async function seedDbFile(
  runtime: Runtime,
  resultCell: ReturnType<Runtime["getCell"]>,
) {
  const handleLink = resultCell.key("db").resolveAsCell()
    .getAsNormalizedFullLink();
  const tx = runtime.edit();
  const db = createCell(
    runtime,
    { ...handleLink, schema: undefined },
    tx,
    false,
    "sqlite",
  ) as unknown as { exec(sql: string, params?: readonly unknown[]): void };
  db.exec("INSERT INTO notes (body) VALUES (?)", ["seed"]);
  const res = await tx.commit();
  expect(res.error).toBeUndefined();
}

function makePattern(
  cf: ReturnType<typeof createTrustedBuilder>["commonfabric"],
) {
  return cf.pattern<{ tables: SqliteTableSchemas }>(({ tables }) => {
    const db = cf.sqliteDatabase({ tables });
    const q = cf.sqliteQuery({
      db,
      sql: "SELECT id, from_addr, to_addrs FROM emails",
      reactOn: db,
    });
    return { db, q };
  });
}

type QueryState = {
  pending?: boolean;
  error?: unknown;
  requestHash?: string;
  result?: unknown[];
};

/** Run the pattern and return schema-less cells for the handle and query docs. */
function runPattern(runtime: Runtime) {
  const { commonfabric: cf } = createTrustedBuilder(runtime);
  const pattern = makePattern(cf);
  const tx = runtime.edit();
  const resultCell = runtime.getCell(space, RESULT_CAUSE, undefined, tx);
  runtime.run(tx, pattern, { tables: makeTables(cf) }, resultCell);
  const commit = tx.commit();
  return { resultCell, commit };
}

/** All sigil links reachable in a RAW stored value (never descends into one). */
function collectSigilLinks(value: unknown, out: unknown[] = []): unknown[] {
  if (isSigilLink(value)) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectSigilLinks(v, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectSigilLinks(v, out);
    return out;
  }
  return out;
}

describe("sqlite handle across runtimes (rule term lists)", () => {
  let server: MemoryV2Server.Server;
  let runtimeA: Runtime;
  let runtimeB: Runtime | undefined;

  beforeEach(() => {
    server = newServer();
    runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: SharedServerStorageManager.overServer(
        { as: signer },
        server,
      ),
    });
    runtimeB = undefined;
  });

  afterEach(async () => {
    // Drain in-flight async builtin work (the query RPC + write-back) before
    // dispose — Client.close rejects pending requests, which would otherwise
    // surface as uncaught rejections and cancel the rest of the suite. Bounded
    // so a genuinely fighting (bug-state) pair cannot hang teardown forever.
    const grace = new Promise((r) => setTimeout(r, 3000));
    await Promise.race([
      Promise.allSettled([runtimeA.settled(), runtimeB?.settled()]),
      grace,
    ]);
    runtimeB?.scheduler.dispose();
    runtimeA.scheduler.dispose();
    await Promise.allSettled([
      runtimeB?.storageManager.synced(),
      runtimeA.storageManager.synced(),
    ]);
    await runtimeB?.dispose();
    await runtimeA.dispose();
    await server.close();
  });

  it("stores the handle value self-contained (term list stays inline)", async () => {
    const { resultCell, commit } = runPattern(runtimeA);
    await commit;
    await runtimeA.idle();

    const handle = resultCell.key("db").resolveAsCell();
    const raw = handle.getRaw() as Record<string, unknown>;
    expect(raw).toBeDefined();
    // The rule survived storage (still a 2-term conjunction)…
    const rowLabel = (handle.key("tables").key("emails") as unknown as {
      get: () => { rowLabel?: { confidentiality?: { allOf?: unknown[] } } };
    }).get()?.rowLabel;
    expect(rowLabel?.confidentiality?.allOf?.length).toBe(2);
    // …and nothing in the stored handle value is a link to another doc: a
    // split-out term doc is unreachable by schema-driven sync, so a second
    // runtime would resolve it to null and destabilize the request hash.
    expect(collectSigilLinks(raw)).toEqual([]);

    // db.exec's rev bump must keep it self-contained too: it writes from a
    // handler frame, where a whole-value set would [ID]-split the term list
    // right back into linked docs. Only the `rev` leaf may change.
    await seedDbFile(runtimeA, resultCell);
    await runtimeA.idle();
    const afterExec = handle.getRaw() as Record<string, unknown>;
    expect((afterExec as { rev?: number }).rev).toBe(1);
    expect(collectSigilLinks(afterExec)).toEqual([]);
  });

  it("a second runtime adopts the settled shared query instead of re-issuing", async () => {
    const a = runPattern(runtimeA);
    await a.commit;
    await runtimeA.idle();
    await seedDbFile(runtimeA, a.resultCell);
    const qCellA = a.resultCell.key("q").resolveAsCell();
    const qA = await waitForCellValue<QueryState>(
      runtimeA,
      qCellA,
      (v) => v?.pending === false && v?.error === undefined,
    );
    expect(qA.error).toBeUndefined();
    const hashA = qA.requestHash;
    expect(typeof hashA).toBe("string");
    await runtimeA.storageManager.synced();

    // Second runtime, separate heap, same server: HYDRATES the same piece
    // (no inputs re-provided — a pure loader, like a second tab).
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: SharedServerStorageManager.overServer(
        { as: signer },
        server,
      ),
    });
    // Count B's server reads: with a stable request hash B must DEDUP against
    // the settled shared result, never issue its own request. (The red failure
    // mode: B's sqliteDatabase re-init rewrote the handle — dropping `rev`,
    // re-deriving `tables` — so BOTH runtimes saw "new inputs", each write
    // invalidating the other's hash on the ONE shared result cell.)
    const providerB = runtimeB.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const originalB = providerB.sqliteQuery.bind(providerB);
    let issuesFromB = 0;
    providerB.sqliteQuery = (...args) => {
      issuesFromB++;
      return originalB(...args);
    };

    const { commonfabric: cfB } = createTrustedBuilder(runtimeB);
    const resultCellB = runtimeB.getCell(space, RESULT_CAUSE, undefined);
    await runtimeB.runSynced(resultCellB, makePattern(cfB));
    const qCellB = resultCellB.key("q").resolveAsCell();
    // Same piece ⇒ same shared query result doc in both runtimes.
    expect(qCellB.getAsNormalizedFullLink().id).toBe(
      qCellA.getAsNormalizedFullLink().id,
    );

    const qB = await waitForCellValue<QueryState>(
      runtimeB!,
      qCellB,
      (v) => v?.pending === false && v?.requestHash === hashA,
    );
    expect(qB.error).toBeUndefined();

    // Stability: B adopted the settled result (no re-issue), and A's hash
    // survived B's hydration untouched.
    await runtimeB!.settled();
    await runtimeA.settled();
    expect(issuesFromB).toBe(0);
    const settledA = qCellA.get() as QueryState;
    expect(settledA.requestHash).toBe(hashA);
    expect(settledA.pending).toBe(false);
    expect(settledA.error).toBeUndefined();
  });
});
