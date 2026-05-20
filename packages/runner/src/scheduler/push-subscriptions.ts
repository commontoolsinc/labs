import { getLogger } from "@commonfabric/utils/logger";
import { setSchedulerDependencies } from "./dependency-updates.ts";
import {
  replaceActionTriggerPaths,
  setCancelForTriggerEntities,
} from "./trigger-index.ts";
import type {
  Action,
  PopulateDependencies,
  PopulateDependenciesEntry,
  ReactivityLog,
} from "./types.ts";
import {
  registerParentChildAction,
  type SchedulerResubscribeOptions,
  type SchedulerSubscribeActionState,
  type SchedulerSubscribeOptions,
  updateSchedulerActionChangeGroup,
  updateSchedulerActionType,
} from "./subscriptions.ts";
import type { Cancel } from "../cancel.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export function subscribePushSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  populateDependencies: PopulateDependencies | ReactivityLog,
  options: SchedulerSubscribeOptions = {},
): Cancel {
  // Handle backwards-compatible ReactivityLog argument
  let populateDependenciesEntry: PopulateDependenciesEntry;
  let immediateLog: ReactivityLog | undefined;
  if (typeof populateDependencies === "function") {
    populateDependenciesEntry = populateDependencies;
  } else {
    // ReactivityLog provided directly - set up dependencies immediately
    // (for backwards compatibility with code that passes reads/writes)
    immediateLog = populateDependencies;
    populateDependenciesEntry = immediateLog;
  }
  const {
    isEffect = false,
    debounce,
    noDebounce,
    throttle,
    deferInitialExecution = false,
  } = options;

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  // Apply debounce settings if provided
  if (debounce !== undefined) {
    state.setDebounce(action, debounce);
  }
  if (noDebounce !== undefined) {
    state.setNoDebounce(action, noDebounce);
  }
  // Apply throttle setting if provided
  if (throttle !== undefined) {
    state.setThrottle(action, throttle);
  }

  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
    {
      queueExecution: !deferInitialExecution,
    },
  );

  // Track parent-child relationship if action is created during another action's execution
  registerParentChildAction(state.subscriptionState, action);

  logger.debug(
    "schedule",
    () => [
      "Subscribing to action:",
      action,
      actionIsEffect ? "effect" : "computation",
    ],
  );

  // Store the populateDependencies callback for use in execute()
  state.populateDependenciesCallbacks.set(action, populateDependenciesEntry);

  if (immediateLog) {
    const { reads, shallowReads, log: schedulingLog } =
      setSchedulerDependencies(
        state.dependencyUpdateState,
        action,
        immediateLog,
      );
    state.updateDependents(action, schedulingLog);
    const { entities } = replaceActionTriggerPaths(
      state.triggerSubscriptionState,
      action,
      reads,
      shallowReads,
    );

    // Register the cancel function for the latest trigger set.
    setCancelForTriggerEntities(
      state.triggerSubscriptionState,
      action,
      entities,
    );
  } else {
    // Mark action for dependency collection before first run
    state.pendingDependencyCollection.add(action);
  }

  if (!deferInitialExecution) {
    state.markDirectDirty(action);
    state.pending.add(action);
    state.scheduledFirstTime.add(action);
  }

  // Emit telemetry for new subscription
  const actionId = state.getActionId(action);
  state.submitSubscribeTelemetry({
    type: "scheduler.subscribe",
    actionId,
    isEffect: actionIsEffect,
  });

  return () => state.unsubscribe(action);
}

export function resubscribePushSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  log: ReactivityLog,
  options: SchedulerResubscribeOptions = {},
): void {
  const { isEffect } = options;

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  const { reads, shallowReads } = setSchedulerDependencies(
    state.dependencyUpdateState,
    action,
    log,
  );

  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
  );
  const actionId = state.getActionId(action);

  // Track parent-child relationship if action is created during another action's execution
  // Only set if not already set (resubscribe can be called multiple times)
  registerParentChildAction(state.subscriptionState, action, {
    allowExisting: false,
  });

  const { entities, triggerPathsByEntity } = replaceActionTriggerPaths(
    state.triggerSubscriptionState,
    action,
    reads,
    shallowReads,
  );

  logger.debug("schedule-resubscribe", () => [
    `Action: ${actionId}`,
    `Entities: ${triggerPathsByEntity.size}`,
    `Reads: ${reads.length}`,
    `Type: ${actionIsEffect ? "effect" : "computation"}`,
  ]);

  setCancelForTriggerEntities(
    state.triggerSubscriptionState,
    action,
    entities,
  );
}
