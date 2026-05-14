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
import { setSchedulerDependencies } from "../src/scheduler/dependency-index.ts";
import {
  clearSchedulerDirectDirty,
  getUpstreamStaleCount as getUpstreamStaleCountFromState,
  isActionStale,
  markDirectDirty as markDirectDirtyState,
  markSchedulerDirty,
} from "../src/scheduler/staleness.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type {
  Action,
  ErrorWithContext,
  EventHandler,
  ReactivityLog,
  TelemetryAnnotations,
} from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type SchedulerPullMode = "default" | "enabled" | "disabled";

type SchedulerTestRuntime = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  tx: IExtendedStorageTransaction;
};

type SchedulerTestStorageManager = SchedulerTestRuntime["storageManager"];

function createSchedulerTestRuntime(
  apiUrl: string | URL,
  options: {
    pullMode?: SchedulerPullMode;
    experimental?: ExperimentalOptions;
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
    ...(options.cfcEnforcementMode
      ? { cfcEnforcementMode: options.cfcEnforcementMode }
      : {}),
  });

  if (options.pullMode === "enabled") {
    runtime.scheduler.enablePullMode();
  } else if (options.pullMode === "disabled") {
    runtime.scheduler.disablePullMode();
  }

  return { storageManager, runtime, tx: runtime.edit() };
}

async function disposeSchedulerTestRuntime(
  testRuntime: SchedulerTestRuntime,
): Promise<void> {
  await testRuntime.tx.commit();
  await testRuntime.runtime?.dispose();
  await testRuntime.storageManager?.close();
}

type StaleSchedulerInternals = {
  pending: Set<Action>;
  dirty: Set<Action>;
  isStale: (action: Action) => boolean;
  isDemandedPullComputation: (action: Action) => boolean;
  getUpstreamStaleCount: (action: Action) => number;
  clearDirectDirty: (action: Action) => boolean;
  markDirectDirty: (action: Action) => boolean;
  markDirty: (action: Action) => void;
  isEffectAction: WeakMap<Action, boolean>;
  setDependencies: (
    action: Action,
    log: ReactivityLog,
  ) => ReturnType<typeof setSchedulerDependencies>;
  updateDependents: (action: Action, log: ReactivityLog) => void;
  collectDirtyDependencies: (
    action: Action,
    workSet: Set<Action>,
    memo?: Map<Action, boolean>,
  ) => boolean;
  scheduleAffectedEffects: (action: Action) => void;
};

function getStaleSchedulerInternals(
  scheduler: Runtime["scheduler"],
): StaleSchedulerInternals {
  const internal = scheduler as unknown as {
    pending: Set<Action>;
    stalenessState:
      & Parameters<typeof isActionStale>[0]
      & Parameters<typeof markDirectDirtyState>[0];
    dirtySchedulingState: Parameters<typeof markSchedulerDirty>[0];
    dependencyUpdateState: Parameters<typeof setSchedulerDependencies>[0];
    isEffectAction: WeakMap<Action, boolean>;
    isDemandedPullComputation: (action: Action) => boolean;
    updateDependents: StaleSchedulerInternals["updateDependents"];
    collectDirtyDependencies: StaleSchedulerInternals[
      "collectDirtyDependencies"
    ];
    scheduleAffectedEffects: StaleSchedulerInternals["scheduleAffectedEffects"];
  };

  return {
    pending: internal.pending,
    dirty: internal.stalenessState.dirty,
    isStale: (action) => isActionStale(internal.stalenessState, action),
    isDemandedPullComputation: (action) =>
      internal.isDemandedPullComputation(action),
    getUpstreamStaleCount: (action) =>
      getUpstreamStaleCountFromState(internal.stalenessState, action),
    clearDirectDirty: (action) =>
      clearSchedulerDirectDirty(internal.dirtySchedulingState, action),
    markDirectDirty: (action) =>
      markDirectDirtyState(internal.stalenessState, action),
    markDirty: (action) =>
      markSchedulerDirty(internal.dirtySchedulingState, action),
    isEffectAction: internal.isEffectAction,
    setDependencies: (action, log) =>
      setSchedulerDependencies(internal.dependencyUpdateState, action, log),
    updateDependents: (action, log) => internal.updateDependents(action, log),
    collectDirtyDependencies: (action, workSet, memo) =>
      internal.collectDirtyDependencies(action, workSet, memo),
    scheduleAffectedEffects: (action) =>
      internal.scheduleAffectedEffects(
        action,
      ),
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
