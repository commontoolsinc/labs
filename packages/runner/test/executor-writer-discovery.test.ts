import { assertEquals, assertStrictEquals } from "@std/assert";
import type { NormalizedFullLink } from "../src/link-utils.ts";
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
