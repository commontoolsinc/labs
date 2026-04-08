import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

type SchedulerInternals = {
  markDirty: (action: Action) => void;
  scheduleAffectedEffects: (action: Action) => void;
};

async function setupSharedSeedGraph(effectCount: number) {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  runtime.scheduler.enablePullMode();

  const tx = runtime.edit();
  const source = runtime.getCell<number>(
    space,
    `bench-pull-seeds-source-${effectCount}`,
    undefined,
    tx,
  );
  source.set(1);
  const intermediate = runtime.getCell<number>(
    space,
    `bench-pull-seeds-intermediate-${effectCount}`,
    undefined,
    tx,
  );
  intermediate.set(0);

  const outputs = Array.from({ length: effectCount }, (_, index) => {
    const output = runtime.getCell<number>(
      space,
      `bench-pull-seeds-output-${effectCount}-${index}`,
      undefined,
      tx,
    );
    output.set(0);
    return output;
  });

  await tx.commit();

  const computation: Action = (actionTx) => {
    const value = source.withTx(actionTx).get();
    intermediate.withTx(actionTx).send(value * 10);
  };

  runtime.scheduler.subscribe(
    computation,
    {
      reads: [source.getAsNormalizedFullLink()],
      shallowReads: [],
      writes: [intermediate.getAsNormalizedFullLink()],
    },
    {},
  );

  for (const [index, output] of outputs.entries()) {
    const effect: Action = (actionTx) => {
      const value = intermediate.withTx(actionTx).get();
      output.withTx(actionTx).send(value + index);
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [intermediate.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
  }

  await runtime.scheduler.idle();

  return { runtime, storageManager, computation };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) {
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench(
  "Scheduler pull - shared dirty dependency fanout (50 effects, 20 reschedules)",
  { group: "pull-shared-memo" },
  async () => {
    const { runtime, storageManager, computation } = await setupSharedSeedGraph(
      50,
    );
    const schedulerInternal = runtime
      .scheduler as unknown as SchedulerInternals;

    for (let i = 0; i < 20; i++) {
      schedulerInternal.markDirty(computation);
      schedulerInternal.scheduleAffectedEffects(computation);
      await runtime.scheduler.idle();
    }

    await cleanup(runtime, storageManager);
  },
);

Deno.bench(
  "Scheduler pull - shared dirty dependency fanout (200 effects, 10 reschedules)",
  { group: "pull-shared-memo" },
  async () => {
    const { runtime, storageManager, computation } = await setupSharedSeedGraph(
      200,
    );
    const schedulerInternal = runtime
      .scheduler as unknown as SchedulerInternals;

    for (let i = 0; i < 10; i++) {
      schedulerInternal.markDirty(computation);
      schedulerInternal.scheduleAffectedEffects(computation);
      await runtime.scheduler.idle();
    }

    await cleanup(runtime, storageManager);
  },
);
