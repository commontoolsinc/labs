import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import { txToReactivityLog } from "./reactivity.ts";
import {
  type DependencyUpdateState,
  setSchedulerDependencies,
} from "./dependency-updates.ts";
import {
  applyActionReadDelta,
  ensureCancelForActionTriggers,
  type TriggerSubscriptionState,
} from "./trigger-index.ts";
import type {
  Action,
  PopulateDependenciesEntry,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export interface DependencyCollectionState {
  readonly runtime: Runtime;
  readonly dependencyUpdateState: DependencyUpdateState;
  readonly triggerSubscriptionState: TriggerSubscriptionState;
  readonly updateDependents: (action: Action, log: ReactivityLog) => void;
}

export interface CollectDependenciesOptions {
  readonly errorLogLabel: string;
  readonly errorMessage: (action: Action, error: unknown) => string;
  readonly updateDependents?: boolean;
  readonly useRawReadsForTriggers?: boolean;
}

export function collectDependenciesForAction(
  state: DependencyCollectionState,
  action: Action,
  populateDependencies: PopulateDependenciesEntry,
  options: CollectDependenciesOptions,
): { log: ReactivityLog; entities: Set<SpaceScopeAndURI> } {
  const log = resolveDependencyLog(
    state,
    action,
    populateDependencies,
    options,
  );

  const { previousLog, reads, shallowReads, log: schedulingLog } =
    setSchedulerDependencies(
      state.dependencyUpdateState,
      action,
      log,
    );
  if (options.updateDependents ?? true) {
    state.updateDependents(action, schedulingLog);
  }

  const readsForTriggers = options.useRawReadsForTriggers ? log.reads : reads;
  const shallowReadsForTriggers = options.useRawReadsForTriggers
    ? log.shallowReads
    : shallowReads;
  const nextTriggerLog = {
    reads: readsForTriggers,
    shallowReads: shallowReadsForTriggers,
  };
  const { entities } = applyActionReadDelta(
    state.triggerSubscriptionState,
    action,
    previousLog,
    nextTriggerLog,
  );
  ensureCancelForActionTriggers(
    state.triggerSubscriptionState,
    action,
  );

  return { log, entities };
}

function resolveDependencyLog(
  state: DependencyCollectionState,
  action: Action,
  populateDependencies: PopulateDependenciesEntry,
  options: CollectDependenciesOptions,
): ReactivityLog {
  if (typeof populateDependencies !== "function") {
    return populateDependencies;
  }

  const depTx = state.runtime.edit();
  try {
    logger.timeStart("collectDependencies", "populate");
    try {
      populateDependencies(depTx);
    } finally {
      logger.timeEnd("collectDependencies", "populate");
    }
  } catch (error) {
    logger.debug(options.errorLogLabel, () => [
      options.errorMessage(action, error),
    ]);
  }
  const log = txToReactivityLog(depTx);
  depTx.abort();
  return log;
}
