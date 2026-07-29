// G1 — the lane-scoped READ seam for `sqlite.query`.
//
// `sqlite.query` picks its on-disk cell-db file from the db's declared scope
// resolved against a (principal, sessionId) scope context (`#cellDbPath`'s
// `scopeTag` ← `Engine.resolveScopeKey`). Every OTHER read verb a lease-bound
// executor session issues resolves that context through the C1.4b acting-context
// seam (`#actingReadScopeContext`): graph.query, docs.read, the scheduler
// snapshot/writer lookups. `sqlite.query` did not — it resolved the SPONSOR's
// context — so a served run acting for alice's lane would open the EXECUTOR
// principal's cell-db file.
//
// These tests pin the seam on the same terms the other verbs are pinned on
// (v2-execution-lane-read-test.ts): the grant's identity decides the file, an
// absent/dead grant rejects in the constant C1.3 shape, an acting context needs
// a lease-bound session, and every session that names no lane keeps today's
// session-derived resolution byte-identically — including the lease-bound
// sponsor mirror `v2-execution-lease-test.ts` pins for `session` scope. The
// seam NARROWS to a lane on request; it never replaces the mirror.

import { assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { parseClientMessage, Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  type ExecutionLease,
  type SqliteDbRef,
} from "../v2.ts";
import { table } from "../v2/sqlite/schema.ts";
import type { SchedulerExecutionContextKey } from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-sqlite-lane-read-space";
const SPONSOR = "did:key:z6Mk-sqlite-lane-read-sponsor-bob";
const LANE_PRINCIPAL = "did:key:z6Mk-sqlite-lane-read-alice";
const OTHER_PRINCIPAL = "did:key:z6Mk-sqlite-lane-read-carol";
const AUDIENCE = "did:key:z6Mk-sqlite-lane-read-audience";

const ALICE_LANE = Engine.userExecutionContextKey(
  LANE_PRINCIPAL,
) as SchedulerExecutionContextKey;
const CAROL_LANE = Engine.userExecutionContextKey(
  OTHER_PRINCIPAL,
) as SchedulerExecutionContextKey;

const TABLES = { notes: table({ id: "integer primary key", body: "text" }) };

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type LaneReadServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ anchorSessionId: string; anchorConnectionId: string }>;
};

const createServer = (name: string): LaneReadServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneReadServer;

const connectClient = async (server: Server): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(SPACE, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

type LaneReadHarness = {
  server: LaneReadServer;
  bobClient: MemoryClient.Client;
  bobSession: ExecutionSession;
  aliceClient: MemoryClient.Client;
  aliceSession: ExecutionSession;
  db: SqliteDbRef;
  unbind: () => void;
  close(): Promise<void>;
};

/** One sponsor-bound executor session (bob) plus alice's own session; both
 * principals hold their own instance of the SAME user-scoped cell-db (same
 * space, same id, same declared scope — only the principal differs). */
const setupHarness = async (
  name: string,
  options: { grantAlice?: boolean } = {},
): Promise<LaneReadHarness> => {
  const server = createServer(name);
  const db: SqliteDbRef = {
    id: `of:sqlite-lane-db-${crypto.randomUUID()}`,
    tables: TABLES,
    scope: "user",
  };
  const bobClient = await connectClient(server);
  const bobSession = await mountAs(bobClient, SPONSOR);
  const aliceClient = await connectClient(server);
  const aliceSession = await mountAs(aliceClient, LANE_PRINCIPAL);
  const insert = (session: ExecutionSession, localSeq: number, body: string) =>
    session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: [body],
      }],
    });
  await insert(bobSession, 1, "sponsor-row");
  await insert(aliceSession, 1, "alice-row");
  await bobSession.setExecutionDemand("", ["space:piece:sqlite-lane-read"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  const unbind = server.bindExecutionSession(
    SPACE,
    bobSession.sessionId,
    lease,
  );
  if (options.grantAlice !== false) {
    await server.openUserLaneGrant(SPACE, "", LANE_PRINCIPAL);
  }
  return {
    server,
    bobClient,
    bobSession,
    aliceClient,
    aliceSession,
    db,
    unbind,
    close: async () => {
      unbind();
      await aliceClient.close();
      await bobClient.close();
      await server.close();
    },
  };
};

const sqliteQueryFor = (
  harness: LaneReadHarness,
  actingContext?: SchedulerExecutionContextKey,
  sessionId: string = harness.bobSession.sessionId,
) =>
  harness.server.sqliteQuery({
    type: "sqlite.query",
    requestId: crypto.randomUUID(),
    space: SPACE,
    sessionId,
    ...(actingContext !== undefined ? { actingContext } : {}),
    db: harness.db,
    sql: "SELECT body FROM notes ORDER BY id",
  });

const bodiesOf = (
  result: { ok?: { rows: unknown[] } },
): string[] => (result.ok?.rows as { body: string }[] ?? []).map((r) => r.body);

/** Constant-shape lane-read rejection: the C1.3 fence-cause vocabulary,
 * identical for a dead and an absent grant. */
const assertLaneReadRejection = (
  error: { name: string; message: string } | undefined,
): void => {
  assertExists(error);
  assertEquals(error.name, "ExecutionLeaseFenceError");
  assertEquals(
    error.message,
    "lane-generation-stale: execution lane grant is fenced or superseded",
  );
};

Deno.test("a lane sqlite read under a live grant opens the lane principal's cell-db", async () => {
  const harness = await setupHarness("memory-v2-sqlite-lane-read-instance");
  try {
    const acting = await sqliteQueryFor(harness, ALICE_LANE);
    assertEquals(acting.error, undefined);
    assertEquals(bodiesOf(acting), ["alice-row"]);

    // A NON-lease session keeps today's session-derived resolution
    // byte-identically: alice reading her own user-scoped db, no acting
    // context, still gets her own instance.
    const ordinary = await sqliteQueryFor(
      harness,
      undefined,
      harness.aliceSession.sessionId,
    );
    assertEquals(ordinary.error, undefined);
    assertEquals(bodiesOf(ordinary), ["alice-row"]);
  } finally {
    await harness.close();
  }
});

Deno.test("a lane sqlite read with an absent or dead grant rejects with the named cause", async () => {
  const harness = await setupHarness("memory-v2-sqlite-lane-read-grant-fence");
  try {
    // Absent grant: carol never had a lane.
    const absent = await sqliteQueryFor(harness, CAROL_LANE);
    assertLaneReadRejection(absent.error);

    // Dead grant: alice's lane drains when her anchoring client disconnects.
    await harness.aliceClient.close();
    const dead = await sqliteQueryFor(harness, ALICE_LANE);
    assertLaneReadRejection(dead.error);
    // Constant shape: byte-identical to the absent-grant rejection.
    assertEquals(dead.error, absent.error);
  } finally {
    await harness.close();
  }
});

Deno.test("an acting context on sqlite.query requires a lease-bound executor session", async () => {
  const harness = await setupHarness("memory-v2-sqlite-lane-read-unbound");
  try {
    const response = await sqliteQueryFor(
      harness,
      ALICE_LANE,
      harness.aliceSession.sessionId,
    );
    assertExists(response.error);
    assertEquals(response.error.name, "ProtocolError");
    assertEquals(
      response.error.message,
      "acting contexts require a lease-bound executor session",
    );
  } finally {
    await harness.close();
  }
});

Deno.test("a lease-bound sqlite read without an acting context still mirrors the sponsor", async () => {
  const harness = await setupHarness("memory-v2-sqlite-lane-read-sponsor");
  try {
    // The seam is strictly ADDITIVE. A lease-bound executor session that names
    // no lane keeps resolving through `#scopeContextForSession` — the sponsor
    // mirror the executor's replica depends on, pinned for `session` scope by
    // "lease-bound execution reads and mirrors sponsor PerSession scope"
    // (v2-execution-lease-test.ts). Naming a lane NARROWS to that lane; it
    // never replaces the mirror.
    const sponsor = await sqliteQueryFor(harness);
    assertEquals(sponsor.error, undefined);
    assertEquals(bodiesOf(sponsor), ["sponsor-row"]);
  } finally {
    await harness.close();
  }
});

Deno.test("sqlite.query carries the acting context across the wire parse", () => {
  const parsed = parseClientMessage(encodeMemoryBoundary({
    type: "sqlite.query",
    requestId: "r1",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    db: { id: "of:db", tables: TABLES, scope: "user" },
    sql: "SELECT 1",
  }));
  assertEquals(parsed?.type, "sqlite.query");
  assertEquals(
    (parsed as { actingContext?: string } | undefined)?.actingContext,
    ALICE_LANE,
  );

  // Requests WITHOUT the field parse exactly as before (additive shape).
  const bare = parseClientMessage(encodeMemoryBoundary({
    type: "sqlite.query",
    requestId: "r2",
    space: SPACE,
    sessionId: "s1",
    db: { id: "of:db", tables: TABLES, scope: "user" },
    sql: "SELECT 1",
  }));
  assertEquals(bare?.type, "sqlite.query");
  assertEquals(
    (bare as { actingContext?: string } | undefined)?.actingContext,
    undefined,
  );
});
