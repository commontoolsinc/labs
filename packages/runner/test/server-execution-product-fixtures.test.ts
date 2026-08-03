import { assert, assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ClientCommit } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  ActionTransactionRouteInput,
  ActionTransactionRouter,
} from "../src/storage/v2.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import type { CandidateClaim } from "../src/executor/deno-space-executor.ts";
import {
  type ActionClaimKey,
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
} from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import { join } from "@std/path";

const TRANSFORMED_LIFT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed, Default, Writable } from 'commonfabric';",
      "export default pattern<{ count: Writable<number | Default<0>> }>(({ count }) => ({",
      "  doubled: computed(() => count.get() * 2),",
      "}));",
    ].join("\n"),
  }],
};

type CapturedAttempt = {
  readonly input: ActionTransactionRouteInput;
  readonly observation: SchedulerActionObservation;
};

const scope = (address: { scope?: unknown }): unknown =>
  address.scope ?? "space";

const covers = (
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean =>
  envelope.space === address.space && envelope.id === address.id &&
  scope(envelope) === scope(address) &&
  envelope.path.length <= address.path.length &&
  envelope.path.every((part, index) => part === address.path[index]);

const addressView = (address: IMemorySpaceAddress) => ({
  space: address.space,
  id: address.id,
  scope: scope(address),
  path: address.path,
});

Deno.test("Writable-backed transformed computed has a complete dynamically valid claim surface", async () => {
  const signer = await Identity.fromPassphrase(
    "server execution transformed lift servability",
  );
  const space = signer.did() as MemorySpace;
  const attempts: CapturedAttempt[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const candidates: unknown[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const actionTransactionRouter: ActionTransactionRouter = (input) => {
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
  };
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter,
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
    const compiled = await runtime.patternManager.compilePattern(
      TRANSFORMED_LIFT_PROGRAM,
      { space },
    );
    const tx = runtime.edit();
    const count = runtime.getCell<number>(space, "lift-count", undefined, tx);
    count.set(2);
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "lift-result",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { count }, result);
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(await handle.pull(), { doubled: 4 });
    await runtime.settled();

    const attempt = attempts.find(({ observation }) =>
      observation.actionKind === "computation" &&
      observation.completeActionScopeSummary !== undefined
    );
    assertExists(
      attempt,
      JSON.stringify({
        attempts: attempts.map(({ observation }) => ({
          actionId: observation.actionId,
          actionKind: observation.actionKind,
          transactionKind: observation.transactionKind,
          hasSummary: observation.completeActionScopeSummary !== undefined,
        })),
        diagnostics,
      }),
    );
    assertEquals(
      classifyStaticActionServability(attempt.observation, space),
      { status: "claim-ready", actionKind: "computation" },
    );
    const summary = attempt.observation.completeActionScopeSummary!;
    const observedReads = [
      ...attempt.observation.reads,
      ...attempt.observation.shallowReads,
    ];
    const uncoveredReads = observedReads.filter((address) =>
      !summary.reads.some((envelope) => covers(envelope, address))
    );
    assertEquals(
      dynamicActionTransactionUnservableReason(
        attempt.input,
        attempt.observation,
        { servedSpace: space, branch: "" },
      ),
      undefined,
      `uncovered transformed reads: ${
        JSON.stringify({
          uncovered: uncoveredReads.map(addressView),
          observed: observedReads.map(addressView),
          certified: summary.reads.map(addressView),
          writes: summary.writes.map(addressView),
          directOutputs: summary.directOutputs.map(addressView),
          observedWrites: attempt.observation.actualChangedWrites.map(
            addressView,
          ),
        })
      }`,
    );
    assertEquals(uncoveredReads, []);
    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.claimKey?.actionId === attempt.observation.actionId
      ),
      [],
    );
    assertEquals(candidates.length, 1);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

const PATTERNS_ROOT = join(import.meta.dirname!, "../../patterns");

for (
  const [name, sourcePath] of [
    ["lunch-poll", join(PATTERNS_ROOT, "lunch-poll/main.tsx")],
    [
      "group-chat",
      join(PATTERNS_ROOT, "cfc-group-chat-demo/main.tsx"),
    ],
  ] as const
) {
  Deno.test(`${name} complete space-scoped computations pass the dynamic claim firewall`, async () => {
    const signer = await Identity.fromPassphrase(
      `server execution product surface ${name}`,
    );
    const space = signer.did() as MemorySpace;
    const attempts: CapturedAttempt[] = [];
    const diagnostics: ExecutorCandidateDiagnostic[] = [];
    const candidates: unknown[] = [];
    const executorRouter = createExecutorActionTransactionRouter({
      servedSpace: space,
      branch: "",
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
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      trustSnapshotProvider: () => ({
        id: `principal:${space}`,
        actingPrincipal: space,
      }),
    });

    try {
      const program = await runtime.harness.resolve(
        new FileSystemProgramResolver(sourcePath, PATTERNS_ROOT),
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const tx = runtime.edit();
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        `${name}-surface-result`,
        undefined,
        tx,
      );
      const handle = runtime.run(tx, compiled, {}, result);
      runtime.prepareTxForCommit(tx);
      assertEquals((await tx.commit()).error, undefined);
      await handle.pull();
      await runtime.settled();

      const failures = attempts.flatMap((attempt) => {
        const staticDecision = classifyStaticActionServability(
          attempt.observation,
          space,
        );
        if (staticDecision.status !== "claim-ready") return [];
        const reason = dynamicActionTransactionUnservableReason(
          attempt.input,
          attempt.observation,
          { servedSpace: space, branch: "" },
        );
        return reason !== "dynamic-read-outside-static-surface" &&
            reason !== "dynamic-write-outside-static-surface"
          ? []
          : [{
            actionId: attempt.observation.actionId,
            reason,
            piece: attempt.observation.completeActionScopeSummary?.piece.id,
            rootResult: result.sourceURI,
            uncoveredReads: [
              ...attempt.observation.reads,
              ...attempt.observation.shallowReads,
            ].filter((address) =>
              !attempt.observation.completeActionScopeSummary!.reads.some(
                (envelope) => covers(envelope, address),
              )
            ).map(addressView),
          }];
      });
      assertEquals(failures, []);
      assertEquals(
        candidates.length > 0,
        true,
        `${name} produced no claim-ready real computation; diagnostics: ${
          JSON.stringify(diagnostics)
        }`,
      );
      // FB29: deterministic zero-verdict pin for the admission-relaxation arc
      // (W2.12–W2.16). The flagship product patterns must emit ZERO R3/R4
      // static verdicts — `untrusted-implementation` / `incomplete-static-
      // surface`: a tightening of the certificate gate, the capability
      // analysis, or the descriptor wiring that pushes a flagship computation
      // out of the certified class turns this red here instead of surviving
      // until the next manual flag-on measurement. (`non-space-read-scope`
      // and friends are the scope-lattice gate — session-rank territory owned
      // by C2 — and are deliberately not pinned here.)
      //
      // The `impl:cf:builtin/wish:v1` exemption this pin used to carry is
      // GONE: the W2.15b deferral was lifted by the 2026-07-29 owner ruling
      // that accepts wish's sidecar egress, and `wish` now carries a W2.15a
      // computation descriptor (see wish-resolver-servability.test.ts). A wish
      // node that regresses to `incomplete-static-surface` must fail here.
      const admissionVerdicts = attempts.flatMap((attempt) => {
        const decision = classifyStaticActionServability(
          attempt.observation,
          space,
        );
        return decision.status === "unservable" &&
            (decision.reason === "untrusted-implementation" ||
              decision.reason === "incomplete-static-surface")
          ? [{
            reason: decision.reason,
            fingerprint: attempt.observation.implementationFingerprint,
          }]
          : [];
      });
      assertEquals(admissionVerdicts, []);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
}

// ---------------------------------------------------------------------------
// C2.10 — the lunch-poll placement guard's CLASSIFICATION half at the router
// seam. The design's §1 evidence: the lunch-poll space's rows classify
// 24 space / 13 user / 226 SESSION context, so pre-C2 the vote workload's
// readers were unservable at space rank (`non-space-*-scope`) and the
// placement gate could not pass. With the C2.5 session dial and an open
// session lane, the same actions must classify claim-ready AT SESSION RANK,
// keyed by the open session lane's canonical context key only (CA9). The
// dial-off leg is the self-control: the identical workload through the
// identical seam produces ZERO session-rank candidates, pinning that the
// dial (not some incidental change) is what turns session placement on.
// The engine-admission half — R7 claim-context-mismatch hard-zero and the
// served-recompute reversal against a real server — is the integration
// gate's (packages/patterns/integration, C2.10).
// ---------------------------------------------------------------------------

const driveLunchPollThroughRouter = async (
  sessionDial: boolean,
): Promise<{
  candidates: CandidateClaim[];
  diagnostics: ExecutorCandidateDiagnostic[];
  sessionLane: string;
  userLane: ActionClaimKey["contextKey"];
}> => {
  const signer = await Identity.fromPassphrase(
    `server execution lunch-poll session placement ${sessionDial}`,
  );
  const space = signer.did() as MemorySpace;
  const sessionLane = sessionExecutionContextKey(
    signer.did(),
    "lunch-poll-router-session-1",
  );
  const userLane = userExecutionContextKey(signer.did());
  const candidates: CandidateClaim[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    ...(sessionDial
      ? {
        userRankCandidates: true,
        sessionRankCandidates: true,
        lanePrincipal: signer.did(),
        openUserLaneKeys: () => [sessionLane, userLane],
      }
      : {}),
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter: (input) => router(input),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    trustSnapshotProvider: () => ({
      id: `principal:${space}`,
      actingPrincipal: space,
    }),
  });
  try {
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(
        join(PATTERNS_ROOT, "lunch-poll/main.tsx"),
        PATTERNS_ROOT,
      ),
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `lunch-poll-session-placement-${sessionDial}`,
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    // The §1 evidence names the VOTE workload specifically: join, add an
    // option, cast a vote — the tally chains re-run over PerSession state
    // (the current-day filter) as plain steady-state recomputes.
    handle.key("joinAs").send({ name: "Alice" });
    await runtime.idle();
    await runtime.settled();
    handle.key("addOption").send({ title: "Sushi Place" });
    await runtime.idle();
    await runtime.settled();
    const options = await handle.key("options").pull() as
      | ReadonlyArray<{ id?: string }>
      | undefined;
    const optionId = options?.[0]?.id;
    assertExists(optionId, "the lunch-poll option was not created");
    handle.key("castVote").send({ optionId, voteType: "green" });
    await runtime.idle();
    await runtime.settled();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
  return { candidates, diagnostics, sessionLane, userLane };
};

/** The scope lattice, BROADEST FIRST (context-lattice §2: `space < user <
 * session`). The index IS the comparison — a lower index is a broader write
 * surface. */
const RANK_LATTICE = ["space", "user", "session"] as const;

type CandidateRank = (typeof RANK_LATTICE)[number];

/** The rank a candidate's lane names. A scoped-rank run keys one candidate
 * per OPEN lane of its own rank (`candidateLaneKeys`), so a candidate's key
 * rank IS the classified rank of the run that emitted it. */
const candidateRank = (
  contextKey: ActionClaimKey["contextKey"],
): CandidateRank =>
  contextKey.startsWith("session:")
    ? "session"
    : contextKey.startsWith("user:")
    ? "user"
    : "space";

/** One logical action instance — the unit whose successive RUNS are compared.
 * Rank belongs to a run of an action in a piece, so two pieces sharing an
 * action id are independent sequences and must not be merged into one. */
const actionRunSequenceKey = (claimKey: ActionClaimKey): string =>
  `${claimKey.actionId} @ ${claimKey.pieceId}`;

/** Each action instance's observed ranks, in candidate-emission order. */
const actionRankSequences = (
  candidates: readonly CandidateClaim[],
): Map<string, CandidateRank[]> => {
  const sequences = new Map<string, CandidateRank[]>();
  for (const candidate of candidates) {
    const key = actionRunSequenceKey(candidate.claimKey);
    const rank = candidateRank(candidate.claimKey.contextKey);
    const sequence = sequences.get(key);
    if (sequence === undefined) sequences.set(key, [rank]);
    else sequence.push(rank);
  }
  return sequences;
};

type RankWidening = {
  readonly action: string;
  readonly from: CandidateRank;
  readonly to: CandidateRank;
};

/** Every point at which an action's rank WIDENED: a run classified it back
 * out to a lane broader than one it had already narrowed past. Narrowing is
 * expected and safe (see the C2.10 docblock below); widening is the
 * violation, so the watermark is the NARROWEST rank seen so far and it never
 * moves back out. */
const rankWidenings = (
  candidates: readonly CandidateClaim[],
): RankWidening[] => {
  const widenings: RankWidening[] = [];
  for (const [action, sequence] of actionRankSequences(candidates)) {
    let narrowest = sequence[0];
    for (const rank of sequence.slice(1)) {
      if (RANK_LATTICE.indexOf(rank) < RANK_LATTICE.indexOf(narrowest)) {
        widenings.push({ action, from: narrowest, to: rank });
      } else {
        narrowest = rank;
      }
    }
  }
  return widenings;
};

/**
 * C2.10, classification half: the real lunch-poll vote workload classifies
 * claim-ready at SESSION rank, keyed by the open session lane's canonical key
 * (CA9), and never WIDENS an action's rank across that action's runs.
 *
 * RANK IS PER RUN. `contextRank` is derived from the summary of the run that
 * just committed — the narrowest scope any admitted surface declares
 * (`scheduler/servability.ts:344-350`, read at
 * `executor/action-transaction-router.ts:424-427`) — and nothing carries it
 * across runs. That is the arc's top box working as designed: *scope is
 * DISCOVERED by running, not declared before it*
 * (`docs/specs/server-side-execution/passivity-arc-orchestration.md`), the
 * same inversion `scoped-cell-instances.md` already applies to write surfaces.
 * An action whose upstreams resolve in order therefore TIGHTENS as it
 * discovers them: `__cfLift_28` — the `{participantIdentity[UI]}`
 * interpolation at `packages/patterns/lunch-poll/main.tsx:1414` — runs
 * space -> user -> session, because the child output it reads whole mixes the
 * parent's user-scoped `#profileName` wish result with the card's
 * `Writable.perSession` state.
 *
 * THIS TEST USED TO ASSERT RANK DISJOINTNESS — that no action ever appears at
 * both scoped ranks. Owner ruling, 2026-07-31: that assertion is wrong. It
 * treats rank as an action-LIFETIME property, and it held only as an artifact
 * of the pre-merge product shape, in which the identity card wished for
 * ITSELF (`participant-identity-card.tsx:149-150` at `ed46f266e`) so no parent
 * lift ever read a user-scoped value alongside session-scoped state. Hoisting
 * those wishes to the parent (`main.tsx:1027-1029`) did not break an
 * invariant; it built the first workload in which rank's per-run nature is
 * observable at this seam.
 *
 * TRANSIENT RANK DIVERGENCE IS SAFE, AND THE LATTICE IS WHY. Two principals
 * can sit at different ranks at the same moment — session-scoped for A while
 * still user-scoped for B, because B has not yet caught up. Nobody thereby
 * gets a BROADER write than anyone else: if the result is space-scoped it is
 * space-scoped for everyone, and if it is user-scoped for one it is *at least*
 * user-scoped for all, with some going finer. The divergence is
 * convergence-in-progress. Simultaneity is separately fenced and does not rest
 * on this test: issuance rejects a second live claim for one action tuple at a
 * chain-compatible rank (`memory/v2/server.ts:1048-1070`,
 * `executionClaimChainCompatible`), so a lane move is revoke-before-issue, and
 * `emitCandidates` skips any lane already holding live authority.
 *
 * WHAT IS STILL FORBIDDEN, AND IS WHAT THIS TEST PINS: widening. Once an
 * action has narrowed, a later run may not classify it back out to a broader
 * lane — that lane would write more broadly than the scope already discovered,
 * which is the §4 cross-principal hazard the exact-lane write rule
 * (`laneAdmitsWriteScope`, `scheduler/servability.ts:903-909`) and the
 * engine's own fence refuse. Narrowing needs no such rule; widening is the
 * only direction that can hand somebody a wider write than the run before it.
 */
Deno.test("lunch-poll vote workload classifies claim-ready at session rank with the session dial on, keyed by the open session lane (C2.10)", async () => {
  const { candidates, diagnostics, sessionLane, userLane } =
    await driveLunchPollThroughRouter(true);
  const sessionCandidates = candidates.filter((candidate) =>
    candidate.claimKey.contextKey.startsWith("session:")
  );
  assert(
    sessionCandidates.length > 0,
    `no session-rank candidate for the lunch-poll workload: ${
      JSON.stringify(candidates.map((candidate) => candidate.claimKey))
    }; diagnostics: ${JSON.stringify(diagnostics.slice(0, 20))}`,
  );
  // CA9: every session-rank candidate names the OPEN session lane's
  // canonical key — never a key fabricated from the bare DID.
  assertEquals(
    sessionCandidates.filter((candidate) =>
      candidate.claimKey.contextKey !== sessionLane
    ),
    [],
    "a session candidate names something other than the open session lane",
  );
  // MONOTONE NARROWING at the router seam, replacing the disjointness clause
  // this test carried from `1a6dcc076` (owner ruling, 2026-07-31 — see the
  // docblock). "Nothing widened" is trivially true of a stream in which no
  // action ever moved rank at all, so the pin is guarded in both directions
  // before it is trusted.
  //
  // GUARD 1 — the workload must actually move an action across ranks, or
  // there is no sequence to be monotone about.
  const rankSequences = actionRankSequences(candidates);
  const movedActions = [...rankSequences].filter(([, ranks]) =>
    new Set(ranks).size > 1
  );
  assert(
    movedActions.length > 0,
    `no action changed rank across its runs, so the narrowing pin proves nothing: ${
      JSON.stringify([...rankSequences])
    }`,
  );
  // GUARD 2 — the detector must REPORT the violation it exists to catch. The
  // widening case: this run's own session-rank candidate, followed by the
  // SAME action re-emitted at the user lane. That is a user lane taking a run
  // whose writes the session lane already owns, and `laneAdmitsWriteScope`
  // (`scheduler/servability.ts:903-909`) is exact-lane, so such a commit could
  // only bounce off the write fence.
  const [sessionCandidate] = sessionCandidates;
  assertEquals(
    rankWidenings([
      sessionCandidate,
      {
        ...sessionCandidate,
        claimKey: { ...sessionCandidate.claimKey, contextKey: userLane },
      },
    ]),
    [{
      action: actionRunSequenceKey(sessionCandidate.claimKey),
      from: "session",
      to: "user",
    }],
    "the widening detector no longer reports a session -> user regression",
  );
  // THE PROPERTY: an action's rank may tighten across its runs; it may never
  // widen back out.
  assertEquals(
    rankWidenings(candidates),
    [],
    "an action's rank WIDENED across its run sequence — a later run classified it back out to a broader lane than one it had already narrowed past",
  );
});

Deno.test("lunch-poll control: the identical workload with the session dial off produces zero session-rank candidates (the §1 collapse, pinned)", async () => {
  const { candidates } = await driveLunchPollThroughRouter(false);
  assertEquals(
    candidates.filter((candidate) =>
      candidate.claimKey.contextKey.startsWith("session:") ||
      candidate.claimKey.contextKey.startsWith("user:")
    ),
    [],
    "scoped-rank candidates appeared with the rank dials off",
  );
  // The space-rank path still produces candidates for the space-context
  // legs — the control proves the DIAL is the discriminator, not a broken
  // workload.
  assert(
    candidates.some((candidate) => candidate.claimKey.contextKey === "space"),
    "the dial-off control produced no space-rank candidate at all",
  );
});
