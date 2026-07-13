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
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
}
