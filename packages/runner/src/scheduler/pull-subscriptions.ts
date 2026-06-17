import { getLogger } from "@commonfabric/utils/logger";
import { toMemorySpaceAddress } from "../link-utils.ts";
import type { Cancel } from "../cancel.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { setSchedulerDependencies } from "./dependency-updates.ts";
import { isLive } from "./dependency-graph.ts";
import { filterIgnoredAddresses } from "./reactivity.ts";
import {
  replaceActionTriggerPaths,
  setCancelForTriggerEntities,
} from "./trigger-index.ts";
import type {
  Action,
  PopulateDependencies,
  PopulateDependenciesEntry,
  ReactivityLog,
  TelemetryAnnotations,
} from "./types.ts";
import {
  markEffectDirtyIfStaleInputs,
  registerParentChildAction,
  type SchedulerResubscribeOptions,
  type SchedulerSubscribeActionState,
  type SchedulerSubscribeOptions,
  updateSchedulerActionChangeGroup,
  updateSchedulerActionType,
} from "./subscriptions.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export function subscribePullSchedulerAction(
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
      queueComputation: state.subscriptionState.getIdempotencyCheckMode(),
    },
  );

  // Track parent-child relationship if action is created during another action's execution
  registerParentChildAction(state.subscriptionState, action);
  const record = state.subscriptionState.nodes.get(action);
  const parentRecord = state.subscriptionState.nodes.parentOf(action);
  if (
    !actionIsEffect &&
    record &&
    parentRecord &&
    isLive(state.subscriptionState.dependencyGraphState, parentRecord)
  ) {
    state.markProvisionalDemand(record);
    if (!deferInitialExecution) {
      state.queueExecution();
    }
  }

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

  // Static write surface (spec scheduler-v2 P4): the action's writes are
  // fixed at registration — declared outputs plus statically resolved
  // redirect targets, already computed by the runner, or a registration-time
  // ReactivityLog supplied by direct scheduler callers. Nothing about the
  // surface is learned from runs.
  const surface = resolveRegistrationSurface(action, immediateLog);
  if (!actionIsEffect && surface.length > 0) {
    state.writeIndex.setSurface(action, surface);
    state.registerWriterDependents(action, surface);
  }

  // If a ReactivityLog was provided directly, set up dependencies immediately.
  // This ensures writes are tracked right away for reverse dependency graph.
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
  } else if (!deferInitialExecution) {
    // Mark action for dependency collection before first run
    state.pendingDependencyCollection.add(action);
  }

  if (!deferInitialExecution) {
    state.markInvalid(action);
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

export function resolveRegistrationSurface(
  action: Action,
  immediateLog: ReactivityLog | undefined,
): IMemorySpaceAddress[] {
  const annotated = action as Partial<TelemetryAnnotations>;
  const annotatedSurface = annotated.writes ?? [];
  const surface = annotatedSurface.length > 0
    ? annotatedSurface.map(toMemorySpaceAddress)
    : (immediateLog?.writes ?? []);
  return sortAndCompactPaths(
    filterIgnoredAddresses(surface, annotated.ignoredSchedulingWrites ?? []),
  );
}

export function resubscribePullSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  log: ReactivityLog,
  options: SchedulerResubscribeOptions = {},
): void {
  const { isEffect } = options;
  const existingRecord = state.subscriptionState.nodes.get(action);

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  const { reads, shallowReads, log: schedulingLog } = setSchedulerDependencies(
    state.dependencyUpdateState,
    action,
    log,
  );

  // Track action type for pull-based scheduling
  // Once an action is marked as an effect, it stays an effect
  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
  );
  const record = state.subscriptionState.nodes.get(action);
  if (!existingRecord && record?.status === "never-ran") {
    state.subscriptionState.nodes.setStatus(action, "clean");
  }
  const actionId = state.getActionId(action);

  // Registering a new edge to a live effect can be the moment an invalid
  // upstream computation becomes demanded.
  state.updateDependents(action, schedulingLog);

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
  ]);

  setCancelForTriggerEntities(
    state.triggerSubscriptionState,
    action,
    entities,
  );

  markEffectDirtyIfStaleInputs(
    state,
    action,
    actionIsEffect,
    reads,
    shallowReads,
  );
}
