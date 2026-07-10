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
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import type {
  Cell,
  IExtendedStorageTransaction,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

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
          message: "forced scheduler receipt test conflict",
        },
      };
    }
    return await original(message);
  };

  return () => {
    server.transact = original;
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

function permanentRejection(
  marker: RuntimeTelemetryMarker,
): string | undefined {
  return (marker as { permanentRejection?: string }).permanentRejection;
}

function receiptCellForEvent<T>(
  runtime: Runtime,
  eventId: string,
): Cell<T> {
  return runtime.getCell<T>(
    space,
    { resultFor: { $ctx: {}, $event: eventId } },
  );
}

function resolvedStreamLink(streamCell: Cell<unknown>, runtime: Runtime) {
  return resolveLink(
    runtime,
    runtime.readTx(),
    streamCell.getAsNormalizedFullLink(),
  );
}

describe("scheduler event receipts", () => {
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

  it("deduplicates redelivered events by create-only receipt", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: { total: number } }
    >(
      (event, { effects }) => {
        handlerInvocations++;
        effects.total += event.value;
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts redelivery root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-redelivery:0:receipts-redelivery-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 1 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 1 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "redelivered event did not settle",
      );
      await root.key("effectsTotal").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("effectsTotal").get()).toBe(1);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("deduplicates redelivered pattern launches by receipt", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const childPattern = pattern<{ value: number }>(({ value }) => {
      return { value };
    });
    let handlerInvocations = 0;
    const launchChild = handler<{ value: number }, Record<string, never>>(
      (event) => {
        handlerInvocations++;
        return childPattern({ value: event.value });
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      return { stream: launchChild({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts launch root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-launch:0:receipts-launch-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      const resultCell = receiptCellForEvent<{ value: number }>(
        runtime,
        eventId,
      );
      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "redelivered launch event did not settle",
      );
      await resultCell.pull();

      expect(handlerInvocations).toBe(2);
      expect(resultCell.get()).toEqual({ value: 7 });
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("retries transient conflicts with the same receipt id", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: { total: number } }
    >(
      (event, { effects }) => {
        handlerInvocations++;
        effects.total += event.value;
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts retry root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const restoreTransact = rejectNextServerTransact(storageManager);
    const eventId = "evt:receipt-retry:0:receipts-retry-root";
    try {
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        { value: 3 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2,
        "retrying receipt event did not commit",
      );
      await root.key("effectsTotal").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("effectsTotal").get()).toBe(3);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(false);
    } finally {
      restoreTransact();
      commitTelemetry.dispose();
    }
  });

  it("rejects redelivered idempotent handlers when all writes elide", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const setHandled = handler<
      unknown,
      { effects: { handled: boolean } }
    >(
      (_event, { effects }) => {
        handlerInvocations++;
        effects.handled = true;
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ handled: false });
      const handled = lift(({ handled }: { handled: boolean }) => handled)(
        effects,
      );
      return { handled, stream: setHandled({ effects }) };
    });
    const rootCell = runtime.getCell<{ handled: boolean; stream: unknown }>(
      space,
      "receipts idempotent root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-idempotent:0:receipts-idempotent-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "idempotent redelivered event did not settle",
      );
      await root.key("handled").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("handled").get()).toBe(true);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("creates a receipt document for handlers that launch nothing", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const noLaunch = handler<unknown, Record<string, never>>(
      () => {
        handlerInvocations++;
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      return { stream: noLaunch({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts no launch root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-empty:0:receipts-empty-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("stream"), runtime),
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1,
      "receipt-only event did not run",
    );
    const resultCell = receiptCellForEvent<Record<string, never>>(
      runtime,
      eventId,
    );
    await resultCell.pull();

    expect(resultCell.get()).toEqual({});
  });

  it("allows redelivered events to commit twice while receipts are disabled", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { commitPreconditions: false } },
    ));

    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: { total: number } }
    >(
      (event, { effects }) => {
        handlerInvocations++;
        effects.total += event.value;
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts flag off root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-flag-off:0:receipts-flag-off-root";
    const streamLink = resolvedStreamLink(root.key("stream"), runtime);
    runtime.scheduler.queueEvent(
      streamLink,
      { value: 5 },
      undefined,
      undefined,
      false,
      { eventId },
    );
    runtime.scheduler.queueEvent(
      streamLink,
      { value: 5 },
      undefined,
      undefined,
      false,
      { eventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2,
      "flag-off redelivery did not commit twice",
    );
    await root.key("effectsTotal").pull();

    expect(handlerInvocations).toBe(2);
    expect(root.key("effectsTotal").get()).toBe(10);
  });
});

Deno.test("navigateTo handler results navigate once and deduplicate redelivery", async () => {
  const navSigner = await Identity.fromPassphrase(
    "receipts navigate operator",
  );
  const navSpace = navSigner.did();
  const storageManager = StorageManager.emulate({ as: navSigner });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { commitPreconditions: true },
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });
  let tx = runtime.edit();

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { NAME, handler, navigateTo, pattern } = commonfabric;

    const Target = pattern(() => ({
      [NAME]: "receipts navigate target",
    }));
    let handlerInvocations = 0;
    const openTarget = handler<Record<string, never>, Record<string, never>>(
      () => {
        handlerInvocations++;
        return navigateTo(Target({}));
      },
      { proxy: true },
    );
    const rootPattern = pattern(() => {
      return { stream: openTarget({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      navSpace,
      "receipts navigate root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-navigate:0:receipts-navigate-root";
    const streamLink = resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

    // First delivery: the receipt must not strangle the launch itself —
    // the deferred navigateTo start has to survive its own receipt mark.
    runtime.scheduler.queueEvent(
      streamLink,
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );
    await waitForSchedulerCondition(
      runtime,
      () => navigations.length >= 1,
      "first navigateTo delivery did not navigate",
    );
    expect(handlerInvocations).toBe(1);
    expect(navigations.length).toBe(1);

    // Redelivery of the same event id: the receipt dedupes; no second
    // navigation.
    runtime.scheduler.queueEvent(
      streamLink,
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2,
      "redelivered navigateTo event did not run",
    );
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.idle();

    expect(navigations.length).toBe(1);
  } finally {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  }
});
