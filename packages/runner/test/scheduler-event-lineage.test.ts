import { Identity } from "@commonfabric/identity";
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
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";

const secondSigner = await Identity.fromPassphrase(
  "scheduler event lineage second space",
);
const secondSpace = secondSigner.did();

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
};
type TestMemoryServer = {
  transact(message: TransactMessage): Promise<TransactResponse>;
};

function emulatedServer(
  storageManager: SchedulerTestStorageManager,
): TestMemoryServer {
  return (storageManager as unknown as { server(): TestMemoryServer }).server();
}

function rejectNextServerTransact(
  storageManager: SchedulerTestStorageManager,
): () => void {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let shouldReject = true;
  server.transact = async (message) => {
    if (shouldReject) {
      shouldReject = false;
      return {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced scheduler lineage test conflict",
        },
      };
    }
    return await original(message);
  };

  return () => {
    server.transact = original;
  };
}

function rejectServerTransacts(
  storageManager: SchedulerTestStorageManager,
): () => void {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  server.transact = (message) => {
    return Promise.resolve({
      type: "response",
      requestId: message.requestId,
      error: {
        name: "ConflictError",
        message: "forced scheduler lineage test conflict",
      },
    });
  };

  return () => {
    server.transact = original;
  };
}

function delayNextServerTransact(
  storageManager: SchedulerTestStorageManager,
) {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"confirm" | "fail">();
  let shouldDelay = true;

  server.transact = async (message) => {
    if (!shouldDelay) {
      return await original(message);
    }
    shouldDelay = false;
    started.resolve();
    const outcome = await release.promise;
    if (outcome === "fail") {
      return {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced scheduler lineage test conflict",
        },
      };
    }
    return await original(message);
  };

  return {
    started: started.promise,
    confirm: () => release.resolve("confirm"),
    fail: () => release.resolve("fail"),
    restore: () => {
      server.transact = original;
    },
  };
}

async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!condition() && performance.now() < deadline) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

async function waitForSignal(
  signal: Promise<void>,
  message: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function expectIdlePending(
  idlePromise: Promise<void>,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      idlePromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => {
        timeoutId = setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    expect(result).toBe("pending");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("scheduler event lineage", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { commitPreconditions: true } },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("commits only the retried origin attempt's same-space follow-up", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage duplication stream a",
      undefined,
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage duplication stream b",
      undefined,
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage duplication origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage duplication payloads",
      undefined,
      tx,
    );
    streamA.set({ $stream: true });
    streamB.set({ $stream: true });
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const restoreTransact = rejectNextServerTransact(storageManager);
    let originAttempts = 0;
    const handlerA: EventHandler = (handlerTx) => {
      originAttempts++;
      originWrites.withTx(handlerTx).set(originAttempts);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        originAttempts,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {});
      await waitForSchedulerCondition(
        runtime,
        () => originAttempts >= 2 && payloads.get().length >= 1,
        "same-space follow-up did not commit",
      );

      expect(originAttempts).toBe(2);
      expect(payloads.get().length).toBe(1);
    } finally {
      restoreTransact();
    }
  });

  it("drops payload-only same-space follow-ups from permanently failed origins", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage permanent stream a",
      undefined,
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage permanent stream b",
      undefined,
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage permanent origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage permanent payloads",
      undefined,
      tx,
    );
    streamA.set({ $stream: true });
    streamB.set({ $stream: true });
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    let originAttempts = 0;
    const handlerA: EventHandler = (handlerTx) => {
      originAttempts++;
      originWrites.withTx(handlerTx).set(originAttempts);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        originAttempts,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
      handlerTx.abort("force lineage permanent failure");
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    // handlerTx.abort() aborts the commit locally (StorageTransactionAborted). A
    // locally-aborted commit is deterministic, not contention: it cannot converge
    // by retrying, so the event path drops it on the first attempt rather than
    // retrying (it is neither a conflict nor a bounded-budget retry). The
    // invariant under test is lineage gating: the payload-only same-space
    // follow-up B queued by the failed origin attempt must not commit.
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {}, true);
    await waitForSchedulerCondition(
      runtime,
      () => originAttempts >= 1,
      "origin did not run",
    );
    await runtime.idle();

    expect(originAttempts).toBe(1);
    expect(payloads.get()).toEqual([]);
  });

  it("keeps retried same-space follow-ups lineage-gated", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage retry stream a",
      undefined,
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage retry stream b",
      undefined,
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage retry origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage retry payloads",
      undefined,
      tx,
    );
    streamA.set({ $stream: true });
    streamB.set({ $stream: true });
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    let descendantAttempts = 0;
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      descendantAttempts++;
      if (descendantAttempts === 1) {
        // Simulate the inSpace("name") resolution path: the run aborts and
        // the scheduler requeues the same event locally.
        throw new RetryImmediately();
      }
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    // Interleaving: the origin commit is held in flight while the descendant
    // dispatches speculatively and requeues itself locally (RetryImmediately).
    // The requeued retry must stay lineage-gated: when the origin then fails,
    // the retry must not run and commit.
    const gate = delayNextServerTransact(storageManager);

    try {
      runtime.scheduler.queueEvent(
        streamA.getAsNormalizedFullLink(),
        {},
        false,
      );
      await waitForSignal(gate.started, "origin commit did not start");
      await waitForSchedulerCondition(
        runtime,
        () => descendantAttempts >= 1,
        "descendant did not dispatch while the origin was pending",
      );
      gate.fail();
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.idle();

      expect(payloads.get()).toEqual([]);
    } finally {
      gate.fail();
      gate.restore();
    }
  });

  it("treats read-only origin transactions as settled", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage read-only origin stream",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage read-only origin payloads",
      undefined,
      tx,
    );
    stream.set({ $stream: true });
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    // cell.send() forwards its transaction as the lineage origin; in read
    // contexts that is a read-only readTx() which never commits. Such events
    // are not speculative launches and must dispatch unconditionally instead
    // of throwing from addCommitCallback() or parking forever.
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      "from-read-context",
      undefined,
      undefined,
      false,
      { originTx: runtime.readTx() },
    );
    await waitForSchedulerCondition(
      runtime,
      () => payloads.get().length >= 1,
      "read-only-origin event did not dispatch",
    );

    expect(payloads.get()).toEqual(["from-read-context"]);
  });

  it("parks cross-space follow-ups until the origin confirms", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage cross confirm stream a",
      undefined,
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      secondSpace,
      "lineage cross confirm stream b",
      undefined,
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage cross confirm origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      secondSpace,
      "lineage cross confirm payloads",
      undefined,
      tx,
    );
    streamA.set({ $stream: true });
    originWrites.set(0);
    await tx.commit();
    tx = runtime.edit();
    streamB.withTx(tx).set({ $stream: true });
    payloads.withTx(tx).set([]);
    await tx.commit();
    tx = runtime.edit();

    const gate = delayNextServerTransact(storageManager);
    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    let idlePromise: Promise<void> | undefined;

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {});
      await waitForSignal(gate.started, "origin commit did not start");
      idlePromise = runtime.idle();
      await expectIdlePending(idlePromise);

      expect(payloads.get()).toEqual([]);

      gate.confirm();
      await idlePromise;
      await waitForSchedulerCondition(
        runtime,
        () => payloads.get().length === 1,
        "cross-space follow-up did not dispatch after origin confirmation",
      );
      expect(payloads.get().length).toBe(1);
    } finally {
      gate.confirm();
      gate.restore();
      await idlePromise?.catch(() => {});
    }
  });

  it("drops cross-space follow-ups when the origin fails", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage cross fail stream a",
      undefined,
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      secondSpace,
      "lineage cross fail stream b",
      undefined,
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage cross fail origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      secondSpace,
      "lineage cross fail payloads",
      undefined,
      tx,
    );
    streamA.set({ $stream: true });
    originWrites.set(0);
    await tx.commit();
    tx = runtime.edit();
    streamB.withTx(tx).set({ $stream: true });
    payloads.withTx(tx).set([]);
    await tx.commit();
    tx = runtime.edit();

    const gate = delayNextServerTransact(storageManager);
    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    let idlePromise: Promise<void> | undefined;

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(
        streamA.getAsNormalizedFullLink(),
        {},
        false,
      );
      await waitForSignal(gate.started, "origin commit did not start");
      idlePromise = runtime.idle();
      await expectIdlePending(idlePromise);

      expect(payloads.get()).toEqual([]);

      gate.fail();
      await idlePromise;
      await runtime.idle();
      expect(payloads.get()).toEqual([]);
    } finally {
      gate.fail();
      gate.restore();
      await idlePromise?.catch(() => {});
    }
  });

  it("dispatches stream events whose origin transaction already committed", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage committed-origin stream",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage committed-origin payloads",
      undefined,
      tx,
    );
    stream.set({ $stream: true });
    payloads.set([]);
    await tx.commit();

    const originTx = runtime.edit();
    await originTx.commit();
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    stream.withTx(originTx).send("settled origin payload");
    await waitForSignal(
      runtime.idle(),
      "already-committed origin event did not reach idle",
    );

    expect(payloads.get()).toEqual(["settled origin payload"]);
  });

  it("drops stream events whose origin transaction already failed", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage failed-origin stream",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage failed-origin payloads",
      undefined,
      tx,
    );
    stream.set({ $stream: true });
    payloads.set([]);
    await tx.commit();

    const originTx = runtime.edit();
    originTx.abort("already failed lineage origin");
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    stream.withTx(originTx).send("dropped origin payload");
    await waitForSignal(
      runtime.idle(),
      "already-failed origin event did not reach idle",
    );

    expect(payloads.get()).toEqual([]);
  });

  it("stops handler-result pieces when the handler commit never converges", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    const childPattern = pattern<{ source: number }>(({ source }) => {
      const observed = lift((value: number) => value)(source);
      return { observed };
    });
    let handlerAttempts = 0;
    const launchChild = handler(
      {},
      {
        type: "object",
        properties: {
          source: { type: "number", asCell: ["cell"] },
        },
        required: ["source"],
      },
      (_event, { source }) => {
        handlerAttempts++;
        source.set((source.get() ?? 0) + 1);
        return childPattern({ source });
      },
    );
    const rootPattern = pattern(() => {
      const source = cell(0);
      return {
        launch: launchChild({ source }),
        source,
      };
    });
    const rootCell = runtime.getCell<{ launch: unknown; source: number }>(
      space,
      "lineage handler-result piece stop root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const runningBefore = runtime.runner.cancels.size;
    const restoreTransact = rejectServerTransacts(storageManager);
    try {
      root.key("launch").send({});
      await waitForSchedulerCondition(
        runtime,
        () => handlerAttempts >= 6,
        "handler did not exhaust retries",
      );
      await runtime.idle();

      expect(runtime.runner.cancels.size).toBe(runningBefore);
    } finally {
      restoreTransact();
    }
  });
});
