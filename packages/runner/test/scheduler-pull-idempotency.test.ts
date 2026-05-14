// Inline scheduler idempotency check tests.

import { findDifferingWriteKeys } from "../src/scheduler/diagnosis.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("inline idempotency check mode", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("detects non-idempotent via inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const output = runtime.getCell<number>(
      space,
      "inline-random-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const randomWriter: Action = (tx) => {
      output.withTx(tx).send(Math.random());
    };
    (
      randomWriter as Action & {
        writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      }
    ).writes = [output.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      randomWriter,
      () => {},
      {},
    );
    await output.pull();

    expect(runtime.scheduler.getIdempotencyViolations().length).toBeGreaterThan(
      0,
    );
  });

  it("does not flag idempotent computations in inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const input = runtime.getCell<number>(
      space,
      "inline-idempotent-input",
      undefined,
      tx,
    );
    input.set(5);
    const output = runtime.getCell<number>(
      space,
      "inline-idempotent-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const doubler: Action = (tx) => {
      output.withTx(tx).send(input.withTx(tx).get() * 2);
    };
    (
      doubler as Action & {
        writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      }
    ).writes = [output.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      doubler,
      (tx) => {
        input.withTx(tx).get();
      },
      {},
    );
    expect(await output.pull()).toBe(10);

    const violations = runtime.scheduler.getIdempotencyViolations()
      .filter((r) =>
        r.runs.some((run) =>
          Object.keys(run.writes).some((k) => k.includes("inline-idempotent"))
        )
      );
    expect(violations.length).toBe(0);
  });

  it("treats removed undefined writes as differing", () => {
    const previousWrites = new Map<string, unknown>([
      ["missing-output", undefined],
    ]);
    const latestWrites = new Map<string, unknown>();

    expect(findDifferingWriteKeys(previousWrites, latestWrites)).toEqual([
      "missing-output",
    ]);
  });
});
