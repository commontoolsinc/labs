import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type {
  Action,
  ErrorWithContext,
  EventHandler,
  TelemetryAnnotations,
} from "../src/scheduler.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

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
  beforeEach,
  describe,
  expect,
  it,
  Runtime,
  signer,
  space,
  StorageManager,
  toMemorySpaceAddress,
};
export type {
  Action,
  Cell,
  ErrorWithContext,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  RuntimeTelemetryMarker,
  StaleSchedulerInternals,
  TelemetryAnnotations,
};
