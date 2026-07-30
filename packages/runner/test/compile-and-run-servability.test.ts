// R5 / wave G: what `compileAndRun` actually needs to run server-side, and
// the one dead write that came out of the `pieceCreatedCallback` deletion.
//
// Everything here is MEASURED through the real executor router. Three prior
// readings of this row were wrong from source reading alone, so the file exists
// to make the next reading start from numbers.
//
// 1. KIND. `compileAndRun` is a COMPUTATION at runtime. Its factory
//    (`builtins/compile-and-run.ts`) returns a bare `Action`, i.e. the legacy
//    format, so `isRawBuiltinResult` is false at `runner.ts:5069` and
//    `builtinIsEffect` is undefined; the registration
//    (`builtins/index.ts:86`) passes no `isEffect` either, so
//    `runner.ts:5326`'s `module.isEffect ?? builtinIsEffect` resolves falsy.
//    The factory-wins rule that makes `llmDialog`/`navigateTo` effects has
//    nothing to override here. It therefore classifies
//    `incomplete-static-surface` (the COMPUTATION arm), not
//    `unknown-effect-surface`.
//
// 2. ITS OWN WRITE SURFACE IS BOUNDED. `runSynced` (`compile-and-run.ts:257`)
//    instantiates and runs an arbitrary compiled pattern under the result
//    document, which read as an unbounded write surface. It is not: the
//    spawned pattern's writes are attributed to the SPAWNED PATTERN's own
//    actions — own action id, own implementation fingerprint (the inner
//    module's content hash), own `pieceId` (the spawned result document), own
//    transformer certificate — and they classify `claim-ready` on their own
//    merits. None of them appears in `compileAndRun`'s observation. The second
//    test measures exactly that.
//
// 3. THE BLOCKER is the async continuation — a mechanism gap rather than a
//    surface-shape gap — and its ATTRIBUTION half is now CLOSED.
//    `compileAndRun` writes from three `editWithRetry` transactions that run
//    AFTER its action transaction committed (error/errors, pending, and
//    `runSynced`'s own setup). `sourceAction` reaches an async continuation
//    only through the post-commit OUTBOX
//    (`storage/extended-storage-transaction.ts` flushes each effect inside
//    `runWithTransactionSourceAction(this.tx.sourceAction, …)`, which
//    `Runtime.edit()` then inherits), so the builtin now enqueues its compile
//    and `runSynced` as a post-commit effect rather than firing
//    `compileOrGetPattern(...).then(...)` inline — the same mechanism
//    `llmDialog` reaches through `enqueueSinkRequestPostCommitEffect`. The
//    third test measures that both surviving continuations inherit the run's
//    source-action object.
//
//    Two properties of that move are load-bearing and easy to undo by
//    accident. The flush is FIRE-AND-FORGET: it starts the compile inside the
//    `runWithTransactionSourceAction` scope — which is where `.catch`/
//    `.finally`/`.then` capture the async context — and returns. Awaiting the
//    compile there would make the scheduler's action commit block until an
//    arbitrary compiled pattern has run, which is the scheduling change the
//    open decision below is about. And a failed commit DROPS the outbox, so the
//    in-memory `previousCallHash` dedup marker is released from a commit
//    callback; without that, a conflict re-run early-returns on the unchanged
//    hash and `pending` is stranded at true forever. That is the weak form of
//    sqliteQuery's marker-ordering hazard (8cb00bbf8): sqlite's `requestHash`
//    is DURABLE and doubles as the dedup gate, so a side that wrote it without
//    issuing wedged the side that was supposed to issue; `previousCallHash` is
//    per-node and in memory, so it can only strand its own node.
//
//    The FOUR-document mint, by contrast, is plumbing rather than a design
//    gap: `ServerBuiltinComputationDescriptor.mintedDocuments` is already an
//    array; only the mint site is singular (`selectorBuiltinResultCause`
//    returns one cause, `selectorMintedResultWrite` in `runner.ts` one link).
//
//    WHAT IS STILL OPEN is the OBSERVATION half. The continuations carry no
//    scheduler observation, and the router's continuation synthesis is
//    EFFECT-ONLY regardless: `supportedBuiltinDescriptor`
//    (`executor/action-transaction-router.ts`) requires both a `serverBuiltin`
//    (effect) descriptor and `observation.actionKind === "effect"`, so the
//    `summaries`/`templates` that `synthesizeBuiltinContinuationObservation`
//    needs are never populated for a computation. Every current
//    `SERVER_COMPUTATION_BUILTIN_IDS` member writes only inside its own
//    synchronous body.
//
//    Minting a computation descriptor for `compileAndRun` TODAY is therefore
//    STILL actively harmful, not merely insufficient: the in-run writes would
//    be claimed and authoritative while the continuations routed
//    `disposition:"local"` (an executor shadow that, per `storage/v2.ts`, is
//    "deliberately not confirmed" and reaches no host), leaving `pending` true
//    forever and never publishing the compile result. Attribution is necessary
//    for continuation synthesis, not sufficient. The open decision is
//    unchanged by the outbox move, which both of its arms needed: whether
//    `compileAndRun` is re-kinded as an EFFECT (reusing that whole mechanism,
//    at the cost of a scheduling change) or continuation synthesis is extended
//    to computation descriptors.
//
// Tripwires. If the first test stops reporting `incomplete-static-surface`,
// something gave `compileAndRun` a descriptor and the paragraphs above must be
// re-read before believing it works. If the second test finds a spawned-pattern
// write inside `compileAndRun`'s observation, the "bounded own surface" finding
// is void. If the third test stops finding the run's `sourceAction` on a
// continuation, the async work is firing inline again and the attribution half
// of the blocker is back; if it finds a continuation that DOES carry a
// scheduler observation, the observation half has been closed elsewhere and the
// open decision above has been settled.
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
import { classifyStaticActionServability } from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

const COMPILE_AND_RUN_FINGERPRINT = "impl:cf:builtin/compileAndRun:v1";

/** The compiled-and-run pattern. `shouted` is a transformer-lifted
 *  computation, so the spawned pattern contributes a scheduler action of its
 *  own rather than only alias links. */
const INNER = [
  "/// <cts-enable />",
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ seed: string }>(({ seed }) => ({",
  "  echo: seed,",
  "  shouted: seed.toUpperCase(),",
  "}));",
].join("\n");

const OUTER: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { compileAndRun, pattern } from 'commonfabric';",
      "export default pattern<{ src: string }>(({ src }) => ({",
      "  compiled: compileAndRun({",
      "    files: [{ name: '/inner.tsx', contents: src }],",
      "    main: '/inner.tsx',",
      "    input: { seed: 'probe-seed' },",
      "  }),",
      "}));",
    ].join("\n"),
  }],
};

type CapturedTransaction = {
  readonly input: ActionTransactionRouteInput;
  readonly observation: SchedulerActionObservation | undefined;
};

type CommitOperation = {
  readonly op: string;
  readonly id: string;
  readonly value?: unknown;
  readonly patches?: ReadonlyArray<
    { op?: string; path?: string; value?: unknown }
  >;
};

const operationsOf = (input: ActionTransactionRouteInput): CommitOperation[] =>
  ((input.commit as unknown as { operations?: CommitOperation[] })
    .operations) ?? [];

/** Run the OUTER pattern to completion and capture every routed transaction
 *  and every executor diagnostic. The action commit is now tracked async work
 *  (it carries a post-commit effect), but its flush only STARTS the compile —
 *  `compileOrGetPattern` itself is never registered — so `settled()` alone
 *  still does not cover the continuation. Poll for the published result instead
 *  of sleeping a fixed interval. */
async function observeCompileAndRun(): Promise<{
  transactions: CapturedTransaction[];
  diagnostics: ExecutorCandidateDiagnostic[];
  space: MemorySpace;
  published: unknown;
}> {
  const signer = await Identity.fromPassphrase("compileAndRun R5 surface");
  const space = signer.did() as MemorySpace;
  const transactions: CapturedTransaction[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {},
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter(input) {
      const route = executorRouter(input);
      const observation = input.commit.schedulerObservation;
      transactions.push({
        input: {
          ...input,
          commit: structuredClone(input.commit) as ClientCommit,
        },
        observation: observation === undefined
          ? undefined
          : structuredClone(observation) as SchedulerActionObservation,
      });
      return route;
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(OUTER, {
      space,
    });
    const tx = runtime.edit();
    const result = runtime.getCell<{
      compiled?: { pending?: boolean; result?: Record<string, unknown> };
    }>(space, "compile-and-run-servability", undefined, tx);
    const handle = runtime.run(tx, compiled, { src: INNER }, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();

    let published: Record<string, unknown> | undefined;
    for (let round = 0; round < 100 && published === undefined; round++) {
      await runtime.settled();
      published = result.get()?.compiled?.result;
      if (published !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runtime.settled();
    assertEquals(
      published,
      { echo: "probe-seed", shouted: "PROBE-SEED" },
      "the inner pattern must have compiled AND run — otherwise the " +
        "measurements below describe a failed compile, not a successful one",
    );

    return { transactions, diagnostics, space, published };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

Deno.test("R5: compileAndRun is a COMPUTATION and rejects on the computation arm", async () => {
  const { transactions, diagnostics, space } = await observeCompileAndRun();

  const runs = transactions.filter(({ observation }) =>
    observation?.implementationFingerprint === COMPILE_AND_RUN_FINGERPRINT
  );
  assert(
    runs.length > 0,
    "expected at least one compileAndRun action-run observation",
  );
  for (const { observation } of runs) {
    // The kind that decides which rejection arm applies, and which descriptor
    // family could ever assemble a summary for it.
    assertEquals(observation!.actionKind, "computation");
    assertEquals(
      observation!.completeActionScopeSummary,
      undefined,
      "compileAndRun carries no descriptor, so no summary may assemble",
    );
    assertEquals(
      classifyStaticActionServability(observation!, space),
      { status: "unservable", reason: "incomplete-static-surface" },
    );
  }
  // ...and the router agrees, on the computation code and not the effect one.
  const codes = new Set(diagnostics.map((d) => d.diagnosticCode));
  assert(
    codes.has("incomplete-static-surface"),
    `expected the router to report incomplete-static-surface; saw ${
      JSON.stringify([...codes])
    }`,
  );
  assert(
    !codes.has("unknown-effect-surface"),
    "unknown-effect-surface is the EFFECT arm; seeing it means the kind " +
      "flipped and this file's reasoning must be re-derived",
  );
});

Deno.test("R5: runSynced's spawned pattern writes are the SPAWNED pattern's actions, so compileAndRun's own surface is bounded", async () => {
  const { transactions, space } = await observeCompileAndRun();

  const compileRuns = transactions.filter(({ observation }) =>
    observation?.implementationFingerprint === COMPILE_AND_RUN_FINGERPRINT
  );
  const compilePieceIds = new Set(
    compileRuns.map(({ observation }) => observation!.pieceId),
  );
  assertEquals(
    compilePieceIds.size,
    1,
    "one compileAndRun node, so one pieceId",
  );

  // The spawned pattern's lifted computation. Its fingerprint is the INNER
  // module's content hash, not a builtin id — which is the whole point: it is
  // an ordinary pattern action, not part of compileAndRun's implementation.
  const spawnedRuns = transactions.filter(({ observation }) =>
    observation !== undefined &&
    observation.transactionKind === "action-run" &&
    observation.implementationFingerprint !== COMPILE_AND_RUN_FINGERPRINT &&
    !compilePieceIds.has(observation.pieceId)
  );
  assert(
    spawnedRuns.length > 0,
    "expected the spawned pattern's lifted computation to produce an " +
      "action-run observation of its own; without one this test cannot " +
      "distinguish the two attribution answers",
  );
  for (const { observation } of spawnedRuns) {
    assert(
      observation!.implementationFingerprint.startsWith("impl:cf:module/"),
      `expected an inner-module fingerprint, saw ${
        observation!.implementationFingerprint
      }`,
    );
    // Judged entirely on its own merits — the spawned pattern's derived
    // computations are servable whether or not compileAndRun ever is.
    assertEquals(
      classifyStaticActionServability(observation!, space),
      { status: "claim-ready", actionKind: "computation" },
    );
  }

  // The containment claim: no document the spawned pattern's actions wrote
  // appears in compileAndRun's own observed write surface.
  const spawnedWriteIds = new Set(
    spawnedRuns.flatMap(({ observation }) =>
      observation!.actualChangedWrites.map((address) => address.id)
    ),
  );
  const compileWriteIds = new Set(
    compileRuns.flatMap(({ observation }) =>
      observation!.actualChangedWrites.map((address) => address.id)
    ),
  );
  assertEquals(
    [...compileWriteIds].filter((id) => spawnedWriteIds.has(id)),
    [],
    "a spawned-pattern document inside compileAndRun's observation would " +
      "mean the surface really is unbounded",
  );
  // And it is small: the direct output spot plus the documents it mints. The
  // teardown a RECOMPILE performs adds nothing to this — `Runner.stop`
  // (`runner.ts:2739`, called at `compile-and-run.ts:187`) is in-memory
  // bookkeeping only (cancels, start generations, `removeExecutionDemand`) and
  // makes no storage write, so there is no second, wider shape to measure.
  assert(
    compileWriteIds.size <= 5,
    `compileAndRun's own surface should be its output spot plus at most its ` +
      `four minted documents; saw ${compileWriteIds.size}: ${
        JSON.stringify([...compileWriteIds])
      }`,
  );
});

Deno.test("R5: compileAndRun's async continuations carry the run's sourceAction, so continuation synthesis can reach them", async () => {
  const { transactions } = await observeCompileAndRun();

  const sourceActionOf = (
    input: ActionTransactionRouteInput,
  ): object | undefined => (input as { sourceAction?: object }).sourceAction;

  const compileRuns = transactions.filter(({ observation }) =>
    observation?.implementationFingerprint === COMPILE_AND_RUN_FINGERPRINT
  );
  assert(compileRuns.length > 0, "expected a compileAndRun action run");
  const compileSourceActions = new Set(
    compileRuns.map(({ input }) => sourceActionOf(input)),
  );
  assertEquals(
    compileSourceActions.size,
    1,
    "one compileAndRun node, so one source-action object",
  );
  const [compileSourceAction] = [...compileSourceActions];
  assert(
    compileSourceAction !== undefined,
    "the scheduler sets sourceAction on every action-run transaction " +
      "(scheduler/run.ts:472)",
  );

  // THE MEASUREMENT THIS FILE EXISTS FOR, now flipped. `compileAndRun`'s
  // post-run writes are enqueued as a post-commit effect, so the outbox flush
  // runs them inside `runWithTransactionSourceAction(this.tx.sourceAction, …)`
  // and `Runtime.edit()` stamps the SAME source-action object onto each
  // `editWithRetry` transaction they mint. Identity, not equality: the source
  // action is the `Action` closure itself.
  const continuations = transactions.filter(({ input, observation }) =>
    observation === undefined &&
    sourceActionOf(input) === compileSourceAction
  );
  assert(
    continuations.length > 0,
    "expected compileAndRun's post-run transactions to inherit the run's " +
      "sourceAction; none did, so the async work is firing inline again and " +
      "the continuation-attribution blocker is back",
  );

  // `runSynced`'s setup is among them — the continuation that publishes the
  // compile result by replacing the result document's whole `/value`.
  const setupReplace = continuations.some(({ input }) =>
    operationsOf(input).some((operation) =>
      operation.op === "patch" &&
      (operation.patches ?? []).some((patch) =>
        patch.op === "replace" && patch.path === "/value"
      )
    )
  );
  assert(
    setupReplace,
    "expected runSynced's setup to replace the result document's whole " +
      "/value from a sourceAction-carrying transaction",
  );

  // ...and so is the `pending` clear from the `.finally()` leg.
  const pendingClear = continuations.some(({ input }) =>
    operationsOf(input).some((operation) =>
      (operation.patches ?? []).some((patch) =>
        patch.path === "/value" && patch.value === false
      )
    )
  );
  assert(
    pendingClear,
    "expected the pending flag to go false from a sourceAction-carrying " +
      "transaction",
  );

  // THE HALF THIS DOES NOT CLOSE. The continuations are now attributed but
  // still carry no scheduler observation, so the router has nothing to match a
  // descriptor against. Attribution is necessary for continuation synthesis,
  // not sufficient — see the header docblock.
  const attributedAndObserved = transactions.filter(({ input, observation }) =>
    sourceActionOf(input) === compileSourceAction && observation !== undefined
  );
  assertEquals(
    attributedAndObserved.length,
    compileRuns.length,
    "only the action run itself may carry a scheduler observation; an " +
      "observed continuation means synthesis now reaches computations and " +
      "the header docblock's open decision has been settled elsewhere",
  );
});

// The `isHidden` write at `compile-and-run.ts:263` outlived its motive. It
// existed to keep the AUTO-registered compiled piece out of the default app's
// Patterns list; `5f5d3ffe0` deleted `pieceCreatedCallback`, so nothing
// registers the compiled result any more (`isHidden` is read in exactly one
// place in the product, `patterns/system/default-app.tsx`'s `visiblePieces`
// filter over `allPieces`, and nothing puts a compiled result there).
//
// It was also never observable even before that: `runSynced`'s `setupInternal`
// replaces the same document's whole `/value` one transaction later, and it
// wins deterministically because `runSynced` is called un-awaited at `:257`
// and the `isHidden` edit is fired immediately after, two awaits ahead of the
// setup commit.
//
// So the write is removed. This test is the tripwire: if `isHidden` comes back
// it must come back with a consumer AND an ordering that survives.
Deno.test("R5: a compileAndRun run makes no isHidden write", async () => {
  const { transactions, published } = await observeCompileAndRun();

  const isHiddenWrites: string[] = [];
  for (const { input } of transactions) {
    for (const operation of operationsOf(input)) {
      const serialized = JSON.stringify(operation);
      if (serialized.includes("isHidden")) isHiddenWrites.push(serialized);
    }
  }
  assertEquals(
    isHiddenWrites,
    [],
    "no transaction in a compileAndRun run may write isHidden — the piece " +
      "auto-registration it guarded is gone, and the write never survived " +
      "runSynced's whole-/value replace anyway",
  );
  // The published result carries no trace of it either.
  assertEquals(
    Object.keys(published as Record<string, unknown>).sort(),
    ["echo", "shouted"],
  );
});
