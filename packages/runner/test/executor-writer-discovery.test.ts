import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type SchedulerWriterCandidate as DurableSchedulerWriterCandidate,
  type SchedulerWriterMatch,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Action } from "../src/scheduler/types.ts";
import {
  prepareExecutorDemandPiece,
} from "../src/executor/writer-discovery.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

const PIECE_ID = "space:of:executor-writer-discovery-piece";
const RUNTIME_FINGERPRINT = "runner:scheduler:v3";

type WriterAction = Action & {
  implementationHash: string;
  writes: NormalizedFullLink[];
};

const writerFor = (
  link: NormalizedFullLink,
  implementationHash: string,
): WriterAction => {
  const action = (() => undefined) as unknown as WriterAction;
  action.implementationHash = implementationHash;
  action.writes = [link];
  return action;
};

type DurableWriterProvider = {
  writersForTargets(): Promise<{
    serverSeq: number;
    writers: DurableSchedulerWriterCandidate[];
  }>;
};

function stubDurableWriters(
  runtime: ReturnType<typeof createSchedulerTestRuntime>["runtime"],
  writers: DurableSchedulerWriterCandidate[],
): void {
  const provider = runtime.storageManager.open(
    space,
  ) as unknown as DurableWriterProvider;
  provider.writersForTargets = () => Promise.resolve({ serverSeq: 0, writers });
}

function durableWriterFor(
  target: NormalizedFullLink,
  actionId: string,
  pieceId = PIECE_ID,
): DurableSchedulerWriterCandidate {
  const address = toMemorySpaceAddress(target);
  const matchedWrite: SchedulerWriterMatch = {
    kind: "current-known",
    write: {
      ...address,
      scope: address.scope ?? "space",
      scopeKey: "space",
      path: toDocumentPath([...address.path]),
    },
  };
  return {
    branch: "",
    ownerSpace: space,
    pieceId,
    processGeneration: 0,
    actionId,
    executionContextKey: "space",
    observationId: 1,
    commitSeq: 1,
    observedAtSeq: 1,
    actionKind: "computation",
    implementationFingerprint: `impl:${actionId}`,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    status: "success",
    matchedWrites: [matchedWrite],
  };
}

const multiplierProgram = (multiplier: number): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) =>",
      `  computed(() => (value as any) * ${multiplier}));`,
    ].join("\n"),
  }],
});

Deno.test("executor selects a pre-existing redirected target by writer identity", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const target = env.runtime.getCell(space, "executor-redirected-target");
    const writer = writerFor(
      target.getAsNormalizedFullLink(),
      "impl:executor-redirected-writer",
    );
    env.runtime.scheduler.register(writer, {
      rehydrateFromStorage: {
        space,
        pieceId: PIECE_ID,
        processGeneration: 0,
      },
    });

    const discovery = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId: PIECE_ID,
      target,
      instantiate: () => Promise.resolve(),
    });

    assertEquals(discovery.indexMiss, false);
    assertEquals(discovery.writers.length, 1);
    assertEquals(discovery.writers[0]?.pieceId, PIECE_ID);
    assertStrictEquals(
      discovery.writers[0]?.actionId.includes(
        "impl:executor-redirected-writer",
      ),
      true,
    );
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("executor preserves local writer identity across a cross-space redirect", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const target = env.runtime.getCell(
      space,
      "executor-cross-space-redirect-target",
      undefined,
      env.tx,
    );
    const foreign = env.runtime.getCell(
      "did:key:z6Mk-executor-writer-discovery-foreign-space" as typeof space,
      "executor-cross-space-redirect-foreign",
      undefined,
      env.tx,
    );
    target.setRaw(foreign.getAsWriteRedirectLink());

    const writer = writerFor(
      target.getAsNormalizedFullLink(),
      "impl:executor-cross-space-redirect-writer",
    );
    env.runtime.scheduler.register(writer, {
      rehydrateFromStorage: {
        space,
        pieceId: PIECE_ID,
        processGeneration: 0,
      },
    });

    const discovery = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId: PIECE_ID,
      target,
      instantiate: () => Promise.resolve(),
    });

    assertEquals(discovery.indexMiss, false);
    assertEquals(discovery.writers.length, 1);
    assertStrictEquals(
      discovery.writers[0]?.actionId.includes(
        "impl:executor-cross-space-redirect-writer",
      ),
      true,
    );
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("executor index miss instantiates the demanded piece before discovery", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const target = env.runtime.getCell(space, "executor-index-miss-target");
    let instantiated = 0;
    const discovery = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId: PIECE_ID,
      target,
      instantiate: () => {
        instantiated++;
        env.runtime.scheduler.register(
          writerFor(
            target.getAsNormalizedFullLink(),
            "impl:executor-index-miss-writer",
          ),
          {
            rehydrateFromStorage: {
              space,
              pieceId: PIECE_ID,
              processGeneration: 0,
            },
          },
        );
        return Promise.resolve();
      },
    });

    assertEquals(instantiated, 1);
    assertEquals(discovery.indexMiss, true);
    assertEquals(discovery.writers.length, 1);
    assertEquals(discovery.writers[0]?.pieceId, PIECE_ID);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("executor replaces a stale durable action with the instantiated piece's current action", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const target = env.runtime.getCell(
      space,
      "executor-pattern-update-target",
    );
    const targetLink = target.getAsNormalizedFullLink();
    const oldActionId = "impl:executor-pattern-update-old";
    stubDurableWriters(env.runtime, [
      durableWriterFor(targetLink, oldActionId),
    ]);

    const discovery = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId: PIECE_ID,
      target,
      instantiate: () => {
        env.runtime.scheduler.register(
          writerFor(targetLink, "impl:executor-pattern-update-current"),
          {
            rehydrateFromStorage: {
              space,
              pieceId: PIECE_ID,
              processGeneration: 0,
            },
          },
        );
        return Promise.resolve();
      },
    });

    assertEquals(discovery.indexMiss, false);
    assertEquals(discovery.writers.length, 1);
    assertEquals(discovery.writers[0]?.source, "live");
    assertStrictEquals(
      discovery.writers[0]?.actionId.includes(
        "impl:executor-pattern-update-current",
      ),
      true,
    );
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("executor never falls back to a stale same-piece action after instantiation", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const target = env.runtime.getCell(
      space,
      "executor-pattern-update-no-current-writer",
    );
    const provider = env.runtime.storageManager.open(
      space,
    ) as unknown as DurableWriterProvider;
    let lookupCount = 0;
    provider.writersForTargets = () =>
      Promise.resolve({
        serverSeq: 0,
        writers: lookupCount++ === 0
          ? [
            durableWriterFor(
              target.getAsNormalizedFullLink(),
              "impl:executor-pattern-update-removed",
            ),
          ]
          : [],
      });

    const discovery = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId: PIECE_ID,
      target,
      instantiate: () => Promise.resolve(),
    });

    assertEquals(discovery.indexMiss, false);
    assertEquals(discovery.writers, []);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});

Deno.test("a demanded piece root resolves its current action despite stale scheduler metadata", async () => {
  const env = createSchedulerTestRuntime(import.meta.url);
  try {
    const firstPattern = await env.runtime.patternManager.compilePattern(
      multiplierProgram(2),
      { space },
    );
    const secondPattern = await env.runtime.patternManager.compilePattern(
      multiplierProgram(10),
      { space },
    );
    const target = env.runtime.getCell<number>(
      space,
      "executor-pattern-update-piece",
    );
    const targetLink = target.getAsNormalizedFullLink();
    const pieceId = `${targetLink.scope ?? "space"}:${targetLink.id}`;

    await env.runtime.runSynced(target, firstPattern, { value: 5 });
    assertEquals(await target.pull(), 10);
    const first = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId,
      target,
      instantiate: () => env.runtime.start(target),
    });

    await env.runtime.runSynced(target, secondPattern, { value: 5 });
    assertEquals(await target.pull(), 50);
    const current = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId,
      target,
      instantiate: () => env.runtime.start(target),
    });

    // Simulate a cold executor seeing the previous pattern's durable writer
    // row. The pull demand still names this stable root, whose current
    // patternIdentity names secondPattern. Restarting the root must register
    // that pattern's action and discard the stale same-piece candidate.
    env.runtime.runner.stop(target);
    const staleActionId = first.writers[0]?.actionId;
    if (staleActionId === undefined) {
      throw new Error("initial pattern registered no writer action");
    }
    stubDurableWriters(
      env.runtime,
      [durableWriterFor(targetLink, staleActionId, pieceId)],
    );
    const restarted = await prepareExecutorDemandPiece({
      runtime: env.runtime,
      branch: "",
      pieceId,
      target,
      instantiate: () => env.runtime.start(target),
    });

    assertEquals(first.writers.length, 1);
    assertEquals(current.writers.length, 1);
    assertEquals(restarted.writers.length, 1);
    assertEquals(first.writers[0]?.pieceId, pieceId);
    assertEquals(current.writers[0]?.pieceId, pieceId);
    assertEquals(restarted.writers[0]?.pieceId, pieceId);
    assertStrictEquals(
      current.writers[0]?.actionId !== first.writers[0]?.actionId,
      true,
    );
    assertEquals(
      restarted.writers[0]?.actionId,
      current.writers[0]?.actionId,
    );
    assertStrictEquals(restarted.writers[0]?.source, "live");
    assertEquals(await target.pull(), 50);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});
