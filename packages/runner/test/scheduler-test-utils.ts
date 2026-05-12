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
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type {
  Action,
  ErrorWithContext,
  EventHandler,
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
  isStale: (action: Action) => boolean;
  isDemandedPullComputation: (action: Action) => boolean;
  getUpstreamStaleCount: (action: Action) => number;
  clearDirectDirty: (action: Action) => boolean;
  isEffectAction: WeakMap<Action, boolean>;
  setDependencies: (
    action: Action,
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    },
  ) => {
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    };
  };
  updateDependents: (
    action: Action,
    log: {
      reads: ReturnType<typeof toMemorySpaceAddress>[];
      shallowReads: ReturnType<typeof toMemorySpaceAddress>[];
      writes: ReturnType<typeof toMemorySpaceAddress>[];
    },
  ) => void;
  collectDirtyDependencies: (
    action: Action,
    workSet: Set<Action>,
    memo?: Map<Action, boolean>,
  ) => boolean;
};

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
  RuntimeTelemetryMarker,
  SchedulerTestRuntime,
  SchedulerTestStorageManager,
  StaleSchedulerInternals,
  TelemetryAnnotations,
};
