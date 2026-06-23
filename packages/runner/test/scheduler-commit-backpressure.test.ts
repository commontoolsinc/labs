// Backpressure for committed writes under sustained contention.
//
// A committed write that represents real user intent must converge or fail
// loudly; it must never be silently dropped because a fixed retry budget ran
// out before the contention cleared. These tests drive the event-handler commit
// path against an emulated server that rejects commits on demand:
//
//   1. A burst of transient conflicts longer than the old fixed budget still
//      lets the write land.
//   2. A permanent rejection is not retried (no infinite loop) and stays
//      observable.
//   3. A transient conflict that never clears surfaces a terminal error within
//      the retry window instead of vanishing.

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
  Cell,
  ErrorWithContext,
  IExtendedStorageTransaction,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { resolveLink } from "../src/link-resolution.ts";

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string; precondition?: string };
};
type TestMemoryServer = {
  transact(message: TransactMessage): Promise<TransactResponse>;
};

function emulatedServer(
  storageManager: SchedulerTestStorageManager,
): TestMemoryServer {
  return (storageManager as unknown as { server(): TestMemoryServer }).server();
}

/**
 * Rejects server commits with `error` until `predicate(rejected)` returns false,
 * then passes through to the real server. Returns the number of rejections
 * issued and a restore function. `count: Infinity` rejects every commit.
 */
function rejectServerTransacts(
  storageManager: SchedulerTestStorageManager,
  count: number,
  error: { name: string; message: string; precondition?: string },
): { rejected: () => number; restore: () => void } {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let rejected = 0;
  server.transact = (message) => {
    if (rejected < count) {
      rejected++;
      return Promise.resolve({
        type: "response",
        requestId: message.requestId,
        error,
      });
    }
    return original(message);
  };
  return {
    rejected: () => rejected,
    restore: () => {
      server.transact = original;
    },
  };
}

function collectEventCommitMarkers(runtime: Runtime): {
  markers: RuntimeTelemetryMarker[];
  dispose(): void;
} {
  const markers: RuntimeTelemetryMarker[] = [];
  const listener = (event: Event) => {
    const marker = (event as CustomEvent<{
      marker: RuntimeTelemetryMarker;
    }>).detail.marker;
    if (marker.type === "scheduler.event.commit") {
      markers.push(marker);
    }
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  return {
    markers,
    dispose: () => runtime.telemetry.removeEventListener("telemetry", listener),
  };
}

async function waitFor(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

/**
 * Builds a piece with a single effect handler that adds the event value to a
 * running total. The handler's commit is the committed write under test.
 */
function buildCounterPiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
): {
  total: () => number;
  invocations: () => number;
  queueAdd: (value: number, eventId: string) => void;
} {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  let invocations = 0;
  const recordEvent = handler<
    { value: number },
    { effects: { total: number } }
  >(
    (event, { effects }) => {
      invocations++;
      effects.total += event.value;
    },
    { proxy: true },
  );
  // Expose the stored effects cell directly so the running total can be read
  // synchronously without pulling a computation (pull-mode computations do not
  // run without a subscriber).
  const rootPattern = pattern(() => {
    const effects = cell({ total: 0 });
    return { effects, stream: recordEvent({ effects }) };
  });
  const rootCell = runtime.getCell<
    { effects: { total: number }; stream: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);

  const streamLink = () =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

  return {
    total: () => (root.key("effects").key("total") as Cell<number>).get() ?? 0,
    invocations: () => invocations,
    queueAdd: (value, eventId) => {
      runtime.scheduler.queueEvent(
        streamLink(),
        { value },
        undefined,
        undefined,
        false,
        { eventId },
      );
    },
  };
}

/**
 * Builds a piece whose handler appends the event value to a stored array with a
 * whole-array set (`list = [...list, value]`) — the shape of the profile-append
 * bug, where each append rewrites the list entity and so conflicts with any
 * concurrent writer that bumped the entity's basis sequence.
 */
function buildListPiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
): {
  list: () => readonly number[];
  invocations: () => number;
  queueAppend: (value: number, eventId: string) => void;
} {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  let invocations = 0;
  const appendEvent = handler<
    { value: number },
    { effects: { list: number[] } }
  >(
    (event, { effects }) => {
      invocations++;
      effects.list = [...(effects.list ?? []), event.value];
    },
    { proxy: true },
  );
  const rootPattern = pattern(() => {
    const effects = cell<{ list: number[] }>({ list: [] });
    return { effects, stream: appendEvent({ effects }) };
  });
  const rootCell = runtime.getCell<
    { effects: { list: number[] }; stream: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);

  const streamLink = () =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

  return {
    list: () => (root.key("effects").key("list") as Cell<number[]>).get() ?? [],
    invocations: () => invocations,
    queueAppend: (value, eventId) => {
      runtime.scheduler.queueEvent(
        streamLink(),
        { value },
        undefined,
        undefined,
        false,
        { eventId },
      );
    },
  };
}

describe("committed-write backpressure", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      {
        experimental: { commitPreconditions: true },
        // Fast backoff so retries do not stretch the test; the window is wide
        // enough for the conflict burst to clear in tests 1 and 2.
        commitBackpressure: {
          baseDelayMs: 1,
          maxDelayMs: 4,
          jitter: 0,
          retryWindowMs: 60_000,
        },
      },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it(
    "lands a write after a burst of transient conflicts longer than the old fixed budget",
    async () => {
      const piece = buildCounterPiece(runtime, tx, "backpressure-burst-root");
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // Eight conflicts: well past DEFAULT_RETRIES_FOR_EVENTS (5). The old
      // fixed-budget path gives up after ~6 attempts and drops the write.
      const injector = rejectServerTransacts(storageManager, 8, {
        name: "ConflictError",
        message: "forced transient conflict",
      });

      try {
        piece.queueAdd(3, "evt:backpressure-burst:0:backpressure-burst-root");

        await waitFor(
          runtime,
          () => piece.total() === 3,
          `write did not land after transient conflicts ` +
            `(total=${piece.total()}, rejected=${injector.rejected()}, ` +
            `invocations=${piece.invocations()})`,
        );

        expect(piece.total()).toBe(3);
        expect(injector.rejected()).toBe(8);
        // The handler re-ran for each failed attempt plus the success.
        expect(piece.invocations()).toBeGreaterThanOrEqual(9);
        // The write converged, so no terminal error.
        expect(terminalErrors).toHaveLength(0);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "does not retry a permanent rejection and keeps it observable",
    async () => {
      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-permanent-root",
      );
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();

      const commitTelemetry = collectEventCommitMarkers(runtime);
      // receipt-exists is a permanent precondition failure (idempotent
      // dedup): retrying it would double-handle the event.
      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "PreconditionFailedError",
        message: "forced permanent rejection",
        precondition: "receipt-exists",
      });

      try {
        piece.queueAdd(
          5,
          "evt:backpressure-permanent:0:backpressure-permanent-root",
        );

        await waitFor(
          runtime,
          () => commitTelemetry.markers.length >= 1,
          "permanent rejection never reported a commit marker",
        );
        // Give any erroneous retry a chance to run, then confirm none did.
        await runtime.idle();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await runtime.idle();

        // The handler ran once; a permanent rejection must not re-run it.
        expect(piece.invocations()).toBe(1);
        // The write did not land (the dedup is the whole point).
        expect(piece.total()).toBe(0);
        // The permanent rejection is observable via commit telemetry.
        expect(
          commitTelemetry.markers.some((marker) =>
            (marker as { permanentRejection?: string }).permanentRejection ===
              "receipt-exists"
          ),
        ).toBe(true);
      } finally {
        injector.restore();
        commitTelemetry.dispose();
      }
    },
  );

  it(
    "surfaces a terminal error when a transient conflict never converges",
    async () => {
      await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
      ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
        import.meta.url,
        {
          experimental: { commitPreconditions: true },
          // Short window so the non-converging case fails loudly fast.
          commitBackpressure: {
            baseDelayMs: 1,
            maxDelayMs: 2,
            jitter: 0,
            retryWindowMs: 40,
          },
        },
      ));

      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-stuck-root",
      );
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // Reject every commit: the conflict never clears.
      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "ConflictError",
        message: "forced unending conflict",
      });

      try {
        piece.queueAdd(7, "evt:backpressure-stuck:0:backpressure-stuck-root");

        await waitFor(
          runtime,
          () =>
            terminalErrors.some((error) =>
              error.name === "CommitConvergenceError"
            ),
          `non-converging write did not surface a terminal error ` +
            `(invocations=${piece.invocations()}, total=${piece.total()})`,
        );

        const convergence = terminalErrors.find((error) =>
          error.name === "CommitConvergenceError"
        );
        expect(convergence).toBeDefined();
        // The write never landed, but it failed loudly rather than silently.
        expect(piece.total()).toBe(0);
        // Bounded resource use: the retry window capped the attempt count.
        expect(piece.invocations()).toBeGreaterThan(1);
        expect(piece.invocations()).toBeLessThan(500);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "lands all three array appends through a conflict storm (durable count reaches 3)",
    async () => {
      // The profile-append-during-rehydration bug in miniature: three whole-
      // array appends issued while the entity is churned by a burst of conflicts.
      // Each append rewrites the list, so a stale basis sequence rejects it.
      const piece = buildListPiece(runtime, tx, "backpressure-list-root");
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // A burst longer than the old fixed budget. The old path drops the first
      // append after ~6 attempts, leaving a durable count of 1.
      const injector = rejectServerTransacts(storageManager, 8, {
        name: "ConflictError",
        message: "forced rehydration conflict storm",
      });

      try {
        piece.queueAppend(1, "evt:backpressure-list:0:backpressure-list-root");
        piece.queueAppend(2, "evt:backpressure-list:1:backpressure-list-root");
        piece.queueAppend(3, "evt:backpressure-list:2:backpressure-list-root");

        await waitFor(
          runtime,
          () => piece.list().length === 3,
          `not all appends landed (list=${JSON.stringify(piece.list())}, ` +
            `rejected=${injector.rejected()})`,
        );

        expect(piece.list()).toEqual([1, 2, 3]);
        expect(terminalErrors).toHaveLength(0);
      } finally {
        injector.restore();
      }
    },
  );
});
