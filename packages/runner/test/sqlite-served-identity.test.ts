// OW53 (verification-coverage.md §3): the sqlite builtins' identity
// consumptions under SERVED execution. On a serving runtime the ambient
// trust-snapshot provider names the SERVICE, while the run's acting
// principal arrives WITH the work — the stamped wave-run context
// (serving-loop.md §3c: "never the serving runtime's ambient identity";
// protocol.md §1: identity is "carried into keys, not resolved from
// ambient state"). These pins drive the raw builtins with hand-stamped
// transactions — the exact context shape the serving loop's stamper
// attaches (space-server.ts `#stampRun`) — on a runtime whose ambient
// identity plays the service, so every ambient-vs-run divergence is
// observable in one realm. Composed true-ON coverage lives in
// packages/patterns/integration/sqlite-db-owner-multi-runtime.test.ts and
// sqlite-read-clearance-multi-runtime.test.ts.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { match, principal } from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  sqliteDatabase,
  sqliteQuery,
} from "../src/builtins/sqlite-builtins.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";

const serviceSigner = await Identity.fromPassphrase("ow53 service");
const aliceSigner = await Identity.fromPassphrase("ow53 alice");
const bobSigner = await Identity.fromPassphrase("ow53 bob");
const space = serviceSigner.did();

/** The stamp a demanded derivation run carries on the serving runtime
 * (observed shape: `scopeKeyIdentity` present, `acting` settled later
 * from the discovered scope — so `attributionFromScope` is set and the
 * context carries NO eager `acting`). */
const demandedStamp = (
  tx: IExtendedStorageTransaction,
  principalDid: string,
  sessionId: string,
) =>
  stampWaveRunContext(tx, {
    actionId: "test:ow53",
    kind: "derivation",
    scopeKeyIdentity: { principal: principalDid, sessionId } as never,
    attributionFromScope: true,
  });

interface QueryState {
  pending?: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
  withheld?: number;
}

describe("sqlite-served-identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    // The ambient identity is the SERVICE (the serving runtime's default
    // provider is bound to `storageManager.as` — runtime.ts). The flag is
    // ON: the per-instance scoped-read row these pins read through is
    // claimable only under EXPERIMENTAL_SERVER_EXECUTION (protocol.md §2).
    storageManager = StorageManager.emulate({ as: serviceSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Drive the raw sqliteDatabase builtin once on `tx` (creation run) and
   * return the committed handle value. */
  const driveMint = async (
    rt: Runtime,
    tx: IExtendedStorageTransaction,
  ): Promise<SqliteDbRef & { owner?: string }> => {
    const parent = rt.getCell(
      space,
      `ow53 mint parent ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    const inputs = rt.getImmutableCell(
      space,
      {
        tables: {
          notes: table({ id: "integer primary key", body: "text" }),
        },
      },
      undefined,
      tx,
    );
    let handle: Cell<SqliteDbRef> | undefined;
    const builtin = sqliteDatabase(
      inputs as never,
      (_rtx, result) => {
        handle = result as Cell<SqliteDbRef>;
      },
      () => {},
      [parent],
      parent,
      rt,
    );
    builtin.action(tx);
    expect((await tx.commit()).error).toBeUndefined();
    return handle!.get() as SqliteDbRef & { owner?: string };
  };

  it("mints the stamped run's carried principal as the db owner on a served creation, never the runtime's ambient identity", async () => {
    const tx = runtime.edit();
    demandedStamp(tx, aliceSigner.did(), "sess-alice");
    const handle = await driveMint(runtime, tx);
    // The creating run acts as alice (the demand-supplied principal); the
    // ambient provider names the service. dbOwner() semantics
    // (docs/specs/sqlite-builtin/06-cfc.md: "the principal that created
    // the SqliteDb cell") + serving-loop.md §3c pick the RUN's principal.
    expect(handle.owner).toBe(aliceSigner.did());
  });

  it("mints no owner on a served creation whose run carries no acting principal (fail closed, ownerless handle)", async () => {
    const tx = runtime.edit();
    // An actor-less served run (wave-fallback shape): stamped, but the
    // context carries no identity. Minting the SERVICE as owner would
    // grant it dbOwner() row admission nothing sanctioned; an ownerless
    // handle fails closed downstream (dbOwner() refuses to resolve).
    stampWaveRunContext(tx, { actionId: "test:ow53", kind: "derivation" });
    const handle = await driveMint(runtime, tx);
    expect(handle.owner).toBeUndefined();
  });

  it("keeps the ambient provider as the owner source on an unstamped creation (client neutrality)", async () => {
    // A client runtime: the ambient identity IS the acting user, and a
    // client's runs are never wave-stamped (ON-arm speculation and the
    // whole OFF arm alike — the OFF mint path is additionally pinned by
    // sqlite-db-owner.test.ts).
    const clientManager = StorageManager.emulate({ as: aliceSigner });
    const client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    try {
      const tx = client.edit();
      const handle = await driveMint(client, tx);
      expect(handle.owner).toBe(aliceSigner.did());
    } finally {
      await client.idle();
      await client.dispose();
      await clientManager.close();
    }
  });

  // ---- The cleared-read half (CFC Phase 3.b under served execution) ----

  const KEY = /z[1-9A-HJ-NP-Za-km-z]+/g;

  /** A rule-bearing, clearance-permitted table whose rows each name their
   * intended reader (the integration fixture's shape). */
  const clearedTables = () => ({
    notes: table(
      { id: "integer primary key", reader: "text", body: "text" },
      (f) => ({
        confidentiality: principal("key", match(f.reader, KEY, { min: 1 })),
      }),
      { allowReadClearance: true },
    ),
  });

  /** Seed rows for both readers and return a query builtin over the db,
   * plus the result cell captured from its first run. */
  const clearedQuerySetup = async () => {
    const db = {
      id: `of:ow53-${crypto.randomUUID()}`,
      tables: clearedTables(),
    } as unknown as SqliteDbRef;
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, {
      op: "sqlite",
      db: db as never,
      sql: "INSERT INTO notes (reader, body) VALUES (?, ?), (?, ?), (?, ?)",
      params: [
        aliceSigner.did(),
        "alice-1",
        aliceSigner.did(),
        "alice-2",
        bobSigner.did(),
        "bob-only",
      ],
    });
    expect((await seedTx.commit()).error).toBeUndefined();

    const setupTx = runtime.edit();
    const parent = runtime.getCell(
      space,
      `ow53 query parent ${crypto.randomUUID()}`,
      undefined,
      setupTx,
    );
    const inputs = runtime.getImmutableCell(
      space,
      {
        db: db as never,
        sql: "SELECT id, reader, body FROM notes ORDER BY id",
        reactOn: 1,
        readClearance: true,
      },
      undefined,
      setupTx,
    );
    expect((await setupTx.commit()).error).toBeUndefined();

    let resultCell: Cell<QueryState> | undefined;
    const builtin = sqliteQuery(
      inputs as never,
      (_rtx, result) => {
        resultCell = result as Cell<QueryState>;
      },
      () => {},
      [parent],
      parent,
      runtime,
    );
    return { builtin, result: () => resultCell! };
  };

  it({
    name:
      "keys a cleared read's request hash by each stamped run's acting reader (per-reader runs stage different hashes)",
    // provider.sqliteQuery loads the column-metadata FFI lib
    // (process-lifetime by design) — exempt from the leak detector.
    sanitizeResources: false,
  }, async () => {
    const { builtin, result } = await clearedQuerySetup();

    // Each stamped run stages its claim `{pending, requestHash}` into its
    // OWN transaction (the requesting run's commit carries the claim —
    // serving-loop.md §4). Read each hash back from the run's own staged
    // state, before commit: the durable per-instance landing is the
    // serving loop's wave-commit annotation, which the composed
    // integration pair covers (sqlite-read-clearance-multi-runtime).
    const tx1 = runtime.edit();
    demandedStamp(tx1, aliceSigner.did(), "sess-alice");
    builtin.action(tx1);
    const aliceHash = (result().withTx(tx1).get() as QueryState | undefined)
      ?.requestHash;
    expect((await tx1.commit()).error).toBeUndefined();
    await runtime.settled();

    const tx2 = runtime.edit();
    demandedStamp(tx2, bobSigner.did(), "sess-bob");
    builtin.action(tx2);
    const bobHash = (result().withTx(tx2).get() as QueryState | undefined)
      ?.requestHash;
    expect((await tx2.commit()).error).toBeUndefined();
    await runtime.settled();

    expect(aliceHash).toBeDefined();
    expect(bobHash).toBeDefined();
    // A cleared result depends on WHO is asking (builtins.md §2, RULED
    // 2026-08-02: the reader principal is part of the memo key). With the
    // ambient provider consumed instead, both runs hash the SERVICE and
    // the two hashes collide reader-blind.
    expect(aliceHash).not.toBe(bobHash);
  });
});
