// Inline scheduler idempotency check tests.

import {
  captureTransactionWrites,
  findDifferingWriteKeys,
  makeAddressKey,
} from "../src/scheduler/diagnosis.ts";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
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
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  ReactivityLog,
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

  const logFor = (
    reads: ReturnType<typeof toMemorySpaceAddress>[],
    writes: ReturnType<typeof toMemorySpaceAddress>[],
  ): ReactivityLog => ({
    reads,
    shallowReads: [],
    writes,
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
      logFor([], [toMemorySpaceAddress(output.getAsNormalizedFullLink())]),
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
      logFor(
        [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
        [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      ),
      {},
    );
    expect(await output.pull()).toBe(10);

    // Unfiltered: cell ids are cause-derived hashes, so filtering write keys
    // by the cause string would match nothing and pass vacuously.
    expect(runtime.scheduler.getIdempotencyViolations()).toEqual([]);
  });

  it("does not flag an idempotent computation when an external write lands between run and recheck", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const input = runtime.getCell<number>(
      space,
      "inline-race-input",
      undefined,
      tx,
    );
    input.set(5);
    const output = runtime.getCell<number>(
      space,
      "inline-race-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Pure function of its input — idempotent by construction. The first run
    // queues a microtask that writes the input through a separate
    // transaction, modeling a cross-runtime sync apply landing between the
    // run and its synchronous idempotency recheck (the multi-user `cf test`
    // flake): the recheck then reads newer state than the first run did.
    let injected = false;
    const doubler: Action = (actionTx) => {
      const value = input.withTx(actionTx).get() ?? 0;
      if (!injected) {
        injected = true;
        Promise.resolve().then(() => {
          const interloper = runtime.edit();
          input.withTx(interloper).set(99);
          interloper.commit();
        });
      }
      output.withTx(actionTx).send(value * 2);
    };
    (
      doubler as Action & {
        writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      }
    ).writes = [output.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      doubler,
      logFor(
        [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
        [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      ),
      {},
    );
    await output.pull();
    await runtime.idle();

    expect(runtime.scheduler.getIdempotencyViolations()).toEqual([]);
    // The interloping write itself must still converge.
    expect(await output.pull()).toBe(198);
  });

  it("still flags self-feedback (accumulator) computations in inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const log = runtime.getCell<number[]>(
      space,
      "inline-accumulator",
      undefined,
      tx,
    );
    log.set([]);
    await tx.commit();
    tx = runtime.edit();

    // Reads what it writes — the accumulator anti-pattern. The recheck's
    // second run sees the first run's committed write, so its inputs moved,
    // but the move is covered by the action's own writes and must stay
    // flagged. (Capped so the feedback loop terminates.)
    const accumulator: Action = (actionTx) => {
      const current = log.withTx(actionTx).get() ?? [];
      if (current.length >= 3) return;
      log.withTx(actionTx).set([...current, current.length]);
    };
    (
      accumulator as Action & {
        writes: ReturnType<typeof log.getAsNormalizedFullLink>[];
      }
    ).writes = [log.getAsNormalizedFullLink()];
    runtime.scheduler.subscribe(
      accumulator,
      logFor(
        [toMemorySpaceAddress(log.getAsNormalizedFullLink())],
        [toMemorySpaceAddress(log.getAsNormalizedFullLink())],
      ),
      {},
    );
    await log.pull();
    await runtime.idle();

    expect(
      runtime.scheduler.getIdempotencyViolations().length,
    ).toBeGreaterThan(0);
  });

  it("treats removed undefined writes as differing", () => {
    const previousWrites = new Map<string, FabricValue>([
      ["missing-output", undefined],
    ]);
    const latestWrites = new Map<string, FabricValue>();

    expect(findDifferingWriteKeys(previousWrites, latestWrites)).toEqual([
      "missing-output",
    ]);
  });

  it("ignores a recheck's no-novelty materialization touch", () => {
    // Model the multi-user `cf test` flake at the write-capture boundary. Both
    // runs of the idempotency recheck emit the same value-carrying output, but
    // the fresh recheck run additionally touches a cell it reads — resolving a
    // redirect link into the replica the first time that transaction reads it.
    // The reactivity log records that touch as a write, yet the transaction
    // journal has no novelty for it (the read did not change committed state).
    // The original run, which already materialized the cell, does not touch it.
    // captureTransactionWrites must keep value-carrying writes and drop the
    // touch, so the two runs compare equal instead of flagging a spurious
    // non-idempotency.
    const valueCell = runtime.getCell<number>(
      space,
      "novelty-value-write",
      undefined,
      tx,
    );
    const touchCell = runtime.getCell<number>(
      space,
      "materialization-touch",
      undefined,
      tx,
    );
    const valueAddr = toMemorySpaceAddress(valueCell.getAsNormalizedFullLink());
    const touchAddr = toMemorySpaceAddress(touchCell.getAsNormalizedFullLink());

    // Both transaction journals have novelty for the value write only; the
    // touch never appears in journal novelty.
    const journalWithValueOnly = {
      getWriteDetails: (querySpace: unknown) =>
        querySpace === space ? [{ address: valueAddr, value: 7 }] : [],
    } as unknown as IExtendedStorageTransaction;

    const originalWrites = captureTransactionWrites(journalWithValueOnly, [
      valueAddr,
    ]);
    const recheckWrites = captureTransactionWrites(journalWithValueOnly, [
      valueAddr,
      touchAddr,
    ]);

    expect(recheckWrites.get(makeAddressKey(valueAddr))).toBe(7);
    expect(recheckWrites.has(makeAddressKey(touchAddr))).toBe(false);
    expect(
      findDifferingWriteKeys(originalWrites, recheckWrites, {
        keySet: "latest",
      }),
    ).toEqual([]);
  });
});
