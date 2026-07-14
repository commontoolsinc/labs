/**
 * Repro probe for the review question on PR #4677 (Hixie/Opus point 4):
 *
 * A handler whose captured input resolves through a cross-space link to a
 * locally-absent document classifies as `syncing` during event preflight and
 * input-parks at the queue head. The park's only wake source is a storage
 * write to the preflight reads. But event preflight runs without an
 * executing-action token, so `ensureLinkedDocLoaded` registers no settlement
 * waiter — and a linked-doc load that settles (confirmed absent) produces no
 * storage write. Hypothesis: the parked event never wakes, later events queue
 * behind it forever, and `idle()` resolves throughout (silent stall).
 *
 * The control test performs the identical status read inside a subscribed
 * scheduler action, where an executing-action token IS present: the
 * settlement waiter fires and the action re-runs. Together the two tests
 * either demonstrate the asymmetry or refute the claim.
 */
import { Identity } from "@commonfabric/identity";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getCellWithStatus } from "../src/cell.ts";
import type { Cell } from "../src/builder/types.ts";
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
  EventHandler,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

const otherSigner = await Identity.fromPassphrase("stall probe other space");
const otherSpace = otherSigner.did();

const DEFINED_VALUE_SCHEMA = { not: { type: "undefined" } } as const;

type ProbeStatus = "usable" | "syncing" | "unavailable";

describe("input-parked event vs linked-doc settlement (PR #4677 probe)", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pendingSyncReleases: (() => void)[] = [];
  let syncCalls = 0;
  let originalSyncCell: SchedulerTestStorageManager["syncCell"];

  const releaseSyncs = (): void => {
    const releases = pendingSyncReleases;
    pendingSyncReleases = [];
    for (const release of releases) release();
  };

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
    originalSyncCell = storageManager.syncCell.bind(storageManager);
    syncCalls = 0;
    pendingSyncReleases = [];
    // Defer linked-doc sync settlement for the probe's cross-space targets
    // until the test releases it, so the park-then-settle ordering is
    // deterministic. Settling resolves without writing anything: the target
    // document is authoritatively absent. Unrelated syncs pass through so
    // teardown and commit tracking never block on the probe.
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.space !== otherSpace) return originalSyncCell(cell);
      syncCalls++;
      return new Promise<Cell<T>>((resolve) => {
        pendingSyncReleases.push(() => resolve(cell));
      });
    };
  });

  afterEach(async () => {
    // A failed assertion must not leave a deferred sync wedging teardown.
    releaseSyncs();
    storageManager.syncCell = originalSyncCell;
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  /** Status read mirroring the runner's availability source-position probe. */
  function readLinkedStatus(
    inputCell: Cell<Record<string, unknown>>,
    readTx: IExtendedStorageTransaction,
  ): ProbeStatus {
    const status = getCellWithStatus(
      inputCell.key("data").asSchema(DEFINED_VALUE_SCHEMA).withTx(readTx),
    );
    if ("error" in status) {
      return status.unavailableReason === "syncing" ? "syncing" : "unavailable";
    }
    return "usable";
  }

  function makeLinkedInput(name: string): Cell<Record<string, unknown>> {
    const target = runtime.getCell<number>(otherSpace, `${name}-target`);
    const inputCell = runtime.getCell<Record<string, unknown>>(
      space,
      `${name}-input`,
      undefined,
      tx,
    );
    inputCell.set({ data: target.getAsLink() });
    return inputCell;
  }

  it("parks the head event and never wakes when the linked load settles absent", async () => {
    const inputCell = makeLinkedInput("stall");
    const eventStream = runtime.getCell<number>(
      space,
      "stall-events",
      undefined,
      tx,
    );
    eventStream.set(0);
    await tx.commit();
    tx = runtime.edit();

    let handlerRuns = 0;
    const handledEvents: number[] = [];
    let readinessCalls = 0;
    const statusesSeen: ProbeStatus[] = [];

    const handler: EventHandler = Object.assign(
      (_handlerTx: IExtendedStorageTransaction, event: number) => {
        handlerRuns++;
        handledEvents.push(event);
      },
      {
        inputReadiness: (
          readTx: IExtendedStorageTransaction,
        ): { ready: true } | {
          ready: false;
          reason: "syncing" | "schema-mismatch";
        } => {
          readinessCalls++;
          const status = readLinkedStatus(inputCell, readTx);
          statusesSeen.push(status);
          if (status === "usable") return { ready: true };
          return {
            ready: false,
            reason: status === "syncing" ? "syncing" : "schema-mismatch",
          };
        },
      },
    );
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      (readTx) => {
        readLinkedStatus(inputCell, readTx);
      },
    );

    // Queue while the linked target's replica coverage is still syncing: the
    // preflight classifies `syncing` and input-parks the head.
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(0);
    expect(readinessCalls).toBeGreaterThan(0);
    expect(statusesSeen).toContain("syncing");
    expect(syncCalls).toBeGreaterThan(0);
    const readinessCallsWhileParked = readinessCalls;

    // A later event queues behind the parked head.
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 2);
    await runtime.scheduler.idle();
    expect(handlerRuns).toBe(0);

    // The linked-doc load settles: the document is authoritatively absent.
    // This produces no storage write. If the claim holds, nothing re-checks
    // the parked head: readiness is never re-invoked and the handler never
    // runs, while idle() keeps resolving (the awaits below all return).
    expect(pendingSyncReleases.length).toBeGreaterThan(0);
    releaseSyncs();
    await storageManager.crossSpaceSettled();
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.scheduler.idle();

    const stalled = handlerRuns === 0 &&
      readinessCalls === readinessCallsWhileParked;

    // Regardless of outcome, a write to the preflight-read path must recover
    // the queue. Writing the "data" path itself (the diff must touch the
    // subscribed read, not a sibling key) re-runs readiness, which now
    // classifies usable data, and both queued events dispatch in order.
    const pokeTx = runtime.edit();
    inputCell.withTx(pokeTx).set({ data: 42 });
    await pokeTx.commit();
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.scheduler.idle();

    expect(readinessCalls).toBeGreaterThan(readinessCallsWhileParked);
    expect(handledEvents).toEqual([1, 2]);

    // The decisive assertion, last so the recovery expectations above report
    // their own failures first: settlement alone never woke the parked head.
    expect(stalled).toBe(true);
  });

  it("control: the same read inside a subscribed action re-runs on settlement", async () => {
    const inputCell = makeLinkedInput("control");
    await tx.commit();
    tx = runtime.edit();

    const statuses: ProbeStatus[] = [];
    const controlAction: Action = (actionTx) => {
      statuses.push(readLinkedStatus(inputCell, actionTx));
    };
    // Register as an effect: effects are demand roots in the pull scheduler,
    // so both dependency writes and external-settlement wakes re-run them —
    // the same wake path a real downstream-demanded computation gets.
    runtime.scheduler.subscribe(
      controlAction,
      {
        reads: [
          toMemorySpaceAddress(
            inputCell.key("data").getAsNormalizedFullLink(),
          ),
        ],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    // First run via a dependency write that changes the "data" path itself
    // (the diff must touch the subscribed read): link to a fresh absent
    // target so the run observes `syncing` with an executing-action token.
    inputCell.withTx(tx).set({
      data: runtime.getCell<number>(otherSpace, "control-target-2")
        .getAsLink(),
    });
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(statuses).toContain("syncing");
    const runsWhileSyncing = statuses.length;

    // Settlement without a storage write: the executing-action token
    // registered during the run should wake the action so it can observe the
    // settled (authoritatively absent) state.
    expect(pendingSyncReleases.length).toBeGreaterThan(0);
    releaseSyncs();
    await storageManager.crossSpaceSettled();
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtime.scheduler.idle();

    expect(statuses.length).toBeGreaterThan(runsWhileSyncing);
    expect(statuses[statuses.length - 1]).not.toBe("syncing");
  });
});
