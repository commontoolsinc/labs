import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import type { Entity } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import {
  type ExperimentalOptions,
  Runtime,
  type RuntimeOptions,
} from "../src/runtime.ts";
import { TYPE } from "../src/builder/types.ts";
import {
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import { setSchedulerDependencies } from "../src/scheduler/dependency-updates.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type {
  Action,
  ErrorWithContext,
  EventHandler,
  ReactivityLog,
  TelemetryAnnotations,
} from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
} from "../src/storage/interface.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type SchedulerTestRuntime = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  tx: IExtendedStorageTransaction;
};

type SchedulerTestStorageManager = SchedulerTestRuntime["storageManager"];

function createSchedulerTestRuntime(
  apiUrl: string | URL,
  options: {
    experimental?: ExperimentalOptions;
    commitBackpressure?: RuntimeOptions["commitBackpressure"];
    cfcEnforcementMode?: RuntimeOptions["cfcEnforcementMode"];
    storageManager?: SchedulerTestStorageManager;
  } = {},
): SchedulerTestRuntime {
  const storageManager = options.storageManager ??
    StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: apiUrl instanceof URL ? apiUrl : new URL(apiUrl),
    storageManager,
    ...(options.experimental ? { experimental: options.experimental } : {}),
    ...(options.commitBackpressure
      ? { commitBackpressure: options.commitBackpressure }
      : {}),
    ...(options.cfcEnforcementMode
      ? { cfcEnforcementMode: options.cfcEnforcementMode }
      : {}),
  });

  return { storageManager, runtime, tx: runtime.edit() };
}

async function disposeSchedulerTestRuntime(
  testRuntime: SchedulerTestRuntime,
): Promise<void> {
  await testRuntime.tx.commit();
  await testRuntime.runtime?.dispose();
  await testRuntime.storageManager?.close();
}

async function expectSemanticCommitNotifiesSynchronously(
  storageManager: SchedulerTestStorageManager,
  commit: () => Promise<unknown> | unknown,
): Promise<void> {
  let synchronousSemanticCommitNotifications = 0;
  const subscription: IStorageNotification = {
    next(notification) {
      if (notification.type === "commit") {
        for (const _change of notification.changes) {
          synchronousSemanticCommitNotifications++;
          break;
        }
      }
      return { done: false };
    },
  };

  storageManager.subscribe(subscription);
  try {
    const result = commit();
    expect(synchronousSemanticCommitNotifications).toBeGreaterThan(0);
    await result;
  } finally {
    storageManager.unsubscribe?.(subscription);
  }
}

type StaleSchedulerInternals = {
  pending: Set<Action>;
  isInvalid: (action: Action) => boolean;
  isDemandedPullComputation: (action: Action) => boolean;
  clearInvalid: (action: Action) => void;
  markDirty: (action: Action) => void;
  registerEffect: (action: Action) => void;
  setDependencies: (
    action: Action,
    log: ReactivityLog,
  ) => ReturnType<typeof setSchedulerDependencies>;
  updateDependents: (action: Action, log: ReactivityLog) => void;
};

type SchedulerNodeTestView = {
  register: (action: Action, kind: "effect" | "computation") => unknown;
  get: (
    action: Action,
  ) =>
    | {
      status: "never-ran" | "clean" | "invalid";
      invalidCauses: unknown[];
    }
    | undefined;
};

function getSchedulerInternalField(
  scheduler: Runtime["scheduler"],
  field: string,
): unknown {
  if (!(field in scheduler)) {
    throw new TypeError(`Scheduler internals missing ${field}`);
  }
  return Reflect.get(scheduler, field);
}

function expectObject<T extends object>(value: unknown, field: string): T {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Scheduler internals invalid ${field}`);
  }
  return value as T;
}

function expectSet<T>(value: unknown, field: string): Set<T> {
  if (!(value instanceof Set)) {
    throw new TypeError(`Scheduler internals invalid ${field}`);
  }
  return value;
}

function expectFunction<T>(value: unknown, field: string): T {
  if (typeof value !== "function") {
    throw new TypeError(`Scheduler internals invalid ${field}`);
  }
  return value as T;
}

function getStaleSchedulerInternals(
  scheduler: Runtime["scheduler"],
): StaleSchedulerInternals {
  const pending = expectSet<Action>(
    getSchedulerInternalField(scheduler, "pending"),
    "pending",
  );
  const dependencyUpdateState = expectObject<
    Parameters<typeof setSchedulerDependencies>[0]
  >(
    getSchedulerInternalField(scheduler, "dependencyUpdateState"),
    "dependencyUpdateState",
  );
  const nodes = expectObject<SchedulerNodeTestView>(
    getSchedulerInternalField(scheduler, "nodes"),
    "nodes",
  );
  if (typeof nodes.register !== "function" || typeof nodes.get !== "function") {
    throw new TypeError("Scheduler internals invalid nodes");
  }
  const markAndScheduleInvalidAction = expectFunction<
    (action: Action) => void
  >(
    getSchedulerInternalField(scheduler, "markAndScheduleInvalidAction"),
    "markAndScheduleInvalidAction",
  );
  const isDemandedPullComputation = expectFunction<
    StaleSchedulerInternals["isDemandedPullComputation"]
  >(
    getSchedulerInternalField(scheduler, "isDemandedPullComputation"),
    "isDemandedPullComputation",
  );
  const updateDependents = expectFunction<
    StaleSchedulerInternals["updateDependents"]
  >(
    getSchedulerInternalField(scheduler, "updateDependents"),
    "updateDependents",
  );

  return {
    pending,
    isInvalid: (action) => {
      const record = nodes.get(action);
      return record?.status === "invalid" || record?.status === "never-ran";
    },
    isDemandedPullComputation: (action) =>
      isDemandedPullComputation.call(scheduler, action),
    clearInvalid: (action) => {
      const record = nodes.get(action);
      if (!record) return;
      if (record.status === "invalid") {
        record.status = "clean";
      }
      record.invalidCauses = [];
    },
    markDirty: (action) => markAndScheduleInvalidAction.call(scheduler, action),
    registerEffect: (action) => {
      nodes.register(action, "effect");
    },
    setDependencies: (action, log) =>
      setSchedulerDependencies(dependencyUpdateState, action, log),
    updateDependents: (action, log) =>
      updateDependents.call(scheduler, action, log),
  };
}

type EventPreflightMarker = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.event.preflight" }
>;

export {
  afterEach,
  assertSpyCall,
  assertSpyCalls,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  expectSemanticCommitNotifiesSynchronously,
  getStaleSchedulerInternals,
  ignoreReadForScheduling,
  it,
  Runtime,
  space,
  spy,
  storedCfcMetadataAppliesToPath,
  toMemorySpaceAddress,
  txToReactivityLog,
  TYPE,
};
export type {
  Action,
  Cell,
  Entity,
  ErrorWithContext,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  ReactivityLog,
  RuntimeTelemetryMarker,
  SchedulerTestRuntime,
  SchedulerTestStorageManager,
  StaleSchedulerInternals,
  TelemetryAnnotations,
};
