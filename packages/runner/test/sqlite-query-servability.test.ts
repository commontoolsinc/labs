// R5: `sqliteQuery`'s EFFECT descriptor, and the two things that had to be
// true before the registry entry was safe.
//
// `sqliteQuery` was refused membership of `SERVER_EXECUTABLE_BUILTIN_IDS`
// twice, each time for a reason that has since been closed.
//
//  - "not fetch-shaped, so it stays outside until its own broker exists"
//    (`executor-action-router.test.ts`, pre-2026-07-30). The premise was that
//    membership means a broker route. `navigateTo` retired that rule: what
//    membership buys is the `:server-v1` implementation fingerprint, which is
//    the ONLY key `supportedBuiltinDescriptor` accepts and therefore the only
//    way an effect node acquires an assembled scope summary instead of
//    classifying `unknown-effect-surface`. The first test below pins exactly
//    that: strip the summary and the same observation reads
//    `unknown-effect-surface`.
//  - "nothing server-side runs it at all yet" (same file). Measured, false:
//    the executor Worker's `HostStorageManager` provider forwards
//    `sqliteQuery` over the memory port to the same `sqlite.query` verb the
//    client uses (`storage/v2-host-provider.ts`). A second egress broker would
//    have duplicated a working transport.
//
// The SURFACE half is the first test. `sqliteQuery` mints exactly one document
// — the `QueryState` cell `makeResultCell` allocates — plus the output spot
// linking to it. That mint is not a registered output cell (its scope is
// discovered per transaction), so it rides `serverBuiltinRuntimeWrites`; the
// router renders every runtimeWrites entry at its value-root address AND at
// document root, which is what covers the `["result"]`/`["pattern"]`
// provenance meta `makeResultCell` stamps beside `["value"]`. If the mint ever
// stops being declared, the run de-claims
// `dynamic-write-outside-static-surface` and this file goes red.
//
// The IDENTITY half is the second test, and it is the one that makes
// membership safe rather than merely possible. The query RPC runs in a
// post-commit flush, after `runWithExecutionLane` has restored the ambient
// lane, so `Replica.sqliteQuery` cannot read `#actingLane` the way every other
// read verb does. The builtin captures the lane synchronously in its action
// body and carries it into the flush. A cell-db is a FILE and the scope
// context is its selector, with no downstream per-address check to catch a
// wrong resolution, so a lease-bound executor that failed to name the lane it
// serves would open the EXECUTOR principal's db and return its rows (A5/G1,
// 57dd8da7f). Absence of a lane must stay byte-identical, which is why the
// client leg asserts NO `actingContext` is sent at all.
//
// NOT covered here, and deliberately: `db.exec` writes. They fold a `sqlite`
// op into an arbitrary CALLER's commit, which the routing layer rejects
// unconditionally (`dynamic-sqlite-operation`, CP21/D2). That is a different
// action's transaction, not this node's.
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ClientCommit } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import type { CandidateClaim } from "../src/executor/deno-space-executor.ts";
import {
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
} from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

const QUERY_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, sqliteDatabase, sqliteQuery, table } from 'commonfabric';",
      "export default pattern<{ seed: string }>(() => {",
      "  const db = sqliteDatabase({ tables: { notes: table({",
      "    id: 'integer primary key', body: 'text' }) } });",
      "  return { q: sqliteQuery({ db, sql: 'SELECT body FROM notes',",
      "    reactOn: db }) };",
      "});",
    ].join("\n"),
  }],
};

const QUERY_FINGERPRINT = "impl:cf:builtin/sqliteQuery:server-v1";

type CapturedAttempt = {
  readonly input: ActionTransactionRouteInput;
  readonly observation: SchedulerActionObservation;
};

type Observed = {
  readonly attempts: CapturedAttempt[];
  readonly diagnostics: ExecutorCandidateDiagnostic[];
  readonly candidates: CandidateClaim[];
  readonly queryCalls: { options: unknown }[];
  readonly space: MemorySpace;
};

/** Run a db+query pattern to settlement through the real executor router, so
 *  the DYNAMIC firewall judges the action-run and its post-commit writeback
 *  too. `lane`, when given, stands in for the Worker's `laneRunPins` seam. */
async function observeSqliteQuery(
  passphrase: string,
  lane?: string,
): Promise<Observed> {
  const signer = await Identity.fromPassphrase(passphrase);
  const space = signer.did() as MemorySpace;
  const attempts: CapturedAttempt[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const candidates: CandidateClaim[] = [];
  const queryCalls: { options: unknown }[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    // The Worker's narrow host broker; without it every effect stops at
    // `broker-required` regardless of its descriptor.
    builtinBrokerAvailable: true,
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter(input) {
      const route = executorRouter(input);
      const observation = input.commit.schedulerObservation;
      if (
        observation !== undefined &&
        (observation as { transactionKind?: unknown }).transactionKind ===
          "action-run"
      ) {
        attempts.push({
          input: {
            ...input,
            commit: structuredClone(input.commit) as ClientCommit,
          },
          observation: structuredClone(
            observation,
          ) as SchedulerActionObservation,
        });
      }
      return route;
    },
  });
  if (lane !== undefined) {
    // The one seam the executor Worker feeds (`storage.runWithExecutionLane`
    // → `IStorageManager.actingExecutionLane`). Standing it in here is what
    // lets a plain client Runtime exercise the lane-bound read path.
    (storage as unknown as { actingExecutionLane: () => string })
      .actingExecutionLane = () => lane;
  }
  const provider = storage.open(space) as unknown as {
    sqliteQuery: (...args: unknown[]) => Promise<unknown>;
  };
  const originalQuery = provider.sqliteQuery.bind(provider);
  provider.sqliteQuery = (...args: unknown[]) => {
    queryCalls.push({ options: args[3] });
    return originalQuery(...args);
  };
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    // `sqliteQuery` consults the sink gate BEFORE it flushes
    // (`sqlite-builtins.ts:859`), so this whole file needs a runtime that may
    // egress. It stands in for the executor, which is the only party that runs
    // this effect at all now that a runtime declaring nothing is "suppress" —
    // and without it BOTH tests below go quiet rather than red: the second
    // never reaches `provider.sqliteQuery`, and the first still passes but
    // stops judging the post-commit writeback it claims to cover.
    externalSinkDisposition: "server-executor",
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(
      QUERY_PROGRAM,
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "sqlite-query-servability",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { seed: "probe" }, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    // `idle()` returns before the post-commit RPC; `settled()` waits for the
    // flush AND its writeback, which is the transaction this file cares about.
    await runtime.settled();
    return { attempts, diagnostics, candidates, queryCalls, space };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

function queryRun(observed: Observed): CapturedAttempt {
  const runs = observed.attempts.filter(({ observation }) =>
    observation.implementationFingerprint === QUERY_FINGERPRINT
  );
  assert(
    runs.length > 0,
    `expected a sqliteQuery action-run stamped ${QUERY_FINGERPRINT}; saw ` +
      JSON.stringify(
        observed.attempts.map(({ observation }) =>
          observation.implementationFingerprint
        ),
      ),
  );
  return runs[0];
}

Deno.test("R5: sqliteQuery's effect descriptor assembles a summary and survives the firewall", async () => {
  const observed = await observeSqliteQuery("sqliteQuery R5 surface");
  const { observation, input } = queryRun(observed);

  // It is an EFFECT node, so a computation descriptor could never have served
  // it — `serverBuiltinComputationScopeSummary` requires
  // `actionKind === "computation"` and would mint without ever assembling.
  // This is the trap A3 hit with llmDialog/navigateTo.
  assertEquals(observation.actionKind, "effect");

  // Membership is the whole mechanism: it stamps `:server-v1`, which is the
  // only fingerprint `supportedBuiltinDescriptor` accepts.
  const summary = observation.completeActionScopeSummary;
  assert(
    summary !== undefined,
    "a member of SERVER_EXECUTABLE_BUILTIN_IDS must carry an assembled " +
      "scope summary on its action-run observation",
  );
  assertEquals(
    classifyStaticActionServability(observation, observed.space),
    { status: "broker-required", actionKind: "effect" },
  );

  // ...and the exact rejection membership removes. Strip the summary and the
  // identical observation reads `unknown-effect-surface` — NOT
  // `incomplete-static-surface`, which is the computation arm and finds
  // nothing when grepped for while chasing an effect row.
  assertEquals(
    classifyStaticActionServability(
      { ...observation, completeActionScopeSummary: undefined },
      observed.space,
    ),
    { status: "unservable", reason: "unknown-effect-surface" },
  );

  // The end-to-end verdict, because it is the thing that used to fail.
  assertEquals(
    dynamicActionTransactionUnservableReason(
      input,
      observation,
      { servedSpace: observed.space, branch: "" },
    ),
    undefined,
  );
  assertEquals(
    observed.diagnostics.filter((diagnostic) =>
      diagnostic.diagnosticCode === "unknown-effect-surface" ||
      diagnostic.diagnosticCode === "unsupported-server-builtin" ||
      diagnostic.diagnosticCode === "dynamic-write-outside-static-surface"
    ),
    [],
    "the router judged the whole run — action-run and post-commit writeback " +
      "— without a de-claim",
  );
  assertEquals(
    observed.candidates.filter((candidate) =>
      candidate.builtinId === "sqliteQuery"
    ).map((candidate) => candidate.claimKey.actionKind),
    ["effect"],
    "sqliteQuery produces exactly one effect candidate claim",
  );

  // The mechanism: the ONE minted document. It carries a document-root
  // `["result"]` provenance write beside its `["value"]` payload, and the
  // runtimeWrites declaration covers both because the summary renders each
  // entry at its own path AND at document root.
  const mintedId = observation.actualChangedWrites.find((address) =>
    address.path[0] === "result"
  )?.id;
  assert(
    mintedId !== undefined,
    'expected a document-root ["result"] write from makeResultCell',
  );
  const declaredPaths = summary.writes.filter((write) => write.id === mintedId)
    .map((write) => write.path.join("/")).sort();
  assert(
    declaredPaths.includes("") && declaredPaths.includes("value"),
    "the minted document must be declared at BOTH document root (which is " +
      `what covers ["result"]/["pattern"]) and its value payload; saw ` +
      JSON.stringify(declaredPaths),
  );
  // The same declaration rides the READ side, and it has to: the dedup marker
  // (`requestHash`) and the stale-writeback guard both re-read this document
  // on every rerun. An undeclared re-read is rejected as an unobserved read,
  // and the claim loops revoke/reclaim without ever reaching the broker (the
  // `refreshFromActionRun` branch in `action-transaction-router.ts`).
  assert(
    summary.reads.some((read) =>
      read.id === mintedId && read.path.length === 0
    ),
    "the minted document must also be declared readable at document root",
  );
});

Deno.test("R5: sqliteQuery carries the acting lane into its post-commit read, and nothing when there is none", async () => {
  // The NO-LANE leg FIRST: strict additivity is the property that let this
  // seam land at all, so it is pinned before the narrowing behavior. It used
  // to be called the "client leg", and that name no longer describes anything
  // — a client never reaches this flush. What is being pinned is unchanged and
  // still the load-bearing half: a run with no acting lane must be BYTE-
  // IDENTICAL to every pre-seam run, sending no `actingContext` at all.
  const noLane = await observeSqliteQuery("sqliteQuery R5 no lane");
  assert(
    noLane.queryCalls.length > 0,
    "expected the post-commit flush to reach provider.sqliteQuery",
  );
  assertEquals(
    noLane.queryCalls.map((call) => call.options),
    noLane.queryCalls.map(() => undefined),
    "a run with no acting lane must send no actingContext — anything else " +
      "changes how every existing query resolves its cell-db",
  );

  const alice = "did:key:z6MkrAliceServabilityProbe";
  const lane = `user:${alice}`;
  const laneBound = await observeSqliteQuery(
    "sqliteQuery R5 lane-bound",
    lane,
  );
  assert(
    laneBound.queryCalls.length > 0,
    "expected the post-commit flush to reach provider.sqliteQuery",
  );
  assertEquals(
    laneBound.queryCalls.map((call) => call.options),
    laneBound.queryCalls.map(() => ({ actingContext: lane })),
    "the lane must be captured in the action's synchronous extent and " +
      "carried into the post-commit flush — read there it is already gone, " +
      "and the executor would open the wrong principal's cell-db",
  );
  // The lane-bound run is still served: naming a lane narrows the read, it
  // does not cost the descriptor.
  assertEquals(
    queryRun(laneBound).observation.completeActionScopeSummary === undefined,
    false,
  );
});
