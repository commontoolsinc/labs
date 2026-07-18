import { assertEquals, assertExists } from "@std/assert";
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
      // surface` — beyond the recorded W2.15b `wish` deferral: a tightening
      // of the certificate gate, the capability analysis, or the descriptor
      // wiring that pushes a flagship computation out of the certified class
      // turns this red here instead of surviving until the next manual
      // flag-on measurement. (`non-space-read-scope` and friends are the
      // scope-lattice gate — session-rank territory owned by C2 — and are
      // deliberately not pinned here.)
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
      assertEquals(
        admissionVerdicts.filter((verdict) =>
          verdict.fingerprint !== "impl:cf:builtin/wish:v1"
        ),
        [],
      );
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
  userLane: string;
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
  // Rank disjointness at the router seam (CA9's filter): no action
  // classifies at both scoped ranks.
  const sessionActionIds = new Set(
    sessionCandidates.map((candidate) => candidate.claimKey.actionId),
  );
  const userActionIds = new Set(
    candidates
      .filter((candidate) => candidate.claimKey.contextKey === userLane)
      .map((candidate) => candidate.claimKey.actionId),
  );
  assertEquals(
    [...sessionActionIds].filter((actionId) => userActionIds.has(actionId)),
    [],
    "an action classified at both scoped ranks through the router",
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
