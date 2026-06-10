import type { StorageNotification } from "../storage/interface.ts";
import {
  applyPullTriggeredActionPlan,
  collectTriggeredActionsForChange,
  createTriggerTraceActionRecord,
  createTriggerTraceEntry,
  hasRegisteredTriggers,
  planPullTriggeredAction,
  recordCfcTriggerRead,
  shouldRecordTriggerTraceEntry,
  type StorageNotificationState,
} from "./notifications.ts";
import type {
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
} from "./types.ts";

export function processPullStorageNotification(
  state: StorageNotificationState,
  notification: StorageNotification,
): void {
  const space = notification.space;

  if (!("changes" in notification)) {
    return;
  }

  const sourceChangeGroup = notification.type === "commit"
    ? notification.source?.changeGroup
    : undefined;
  const hasSourceChangeGroup = notification.type === "commit" &&
    sourceChangeGroup !== undefined;
  const collectTriggerTrace = state.getCollectTriggerTrace();
  const diagnosisEnabled = state.getDiagnosisEnabled();

  let changeIndex = 0;
  for (const change of notification.changes) {
    changeIndex++;
    state.recordCellUpdate(change);

    if (!hasRegisteredTriggers(state.triggerIndex)) {
      continue;
    }

    const {
      entity: spaceAndURI,
      hasMatchingTriggerPaths,
      triggeredActions,
    } = collectTriggeredActionsForChange(
      state.triggerIndex,
      space,
      change,
    );

    if (!hasMatchingTriggerPaths) {
      continue;
    }

    const writerActionId = hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ? state.changeGroupToActionId.get(sourceChangeGroup)
      : undefined;
    const triggerTraceEntry: TriggerTraceEntry | null = collectTriggerTrace
      ? createTriggerTraceEntry({
        notificationType: notification.type,
        changeIndex,
        matchedActionCount: triggeredActions.length,
        mode: "pull",
        writerActionId,
        space,
        change,
      })
      : null;

    for (const action of triggeredActions) {
      recordCfcTriggerRead(state, action, space, change);
      // Causal edge tracking for diagnosis.
      if (
        diagnosisEnabled && hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ) {
        const writerActionId = state.changeGroupToActionId.get(
          sourceChangeGroup,
        );
        if (writerActionId) {
          state.recordCausalEdge({
            writer: writerActionId,
            cell: spaceAndURI,
            triggered: state.getActionId(action),
            timestamp: performance.now(),
          });
        }
      }

      const actionChangeGroup = state.actionChangeGroups.get(action);
      const actionId = state.getActionId(action);
      const actionIsEffect = state.effects.has(action);
      const actionType = actionIsEffect ? "effect" : "computation";
      const pendingBefore = state.pending.has(action);
      const dirtyBefore = state.dirty.has(action);
      const isOwnCommitSource = notification.type === "commit" &&
        notification.source !== undefined &&
        state.inFlightSources.get(action)?.has(notification.source) === true;
      const plan = planPullTriggeredAction({
        isEffect: actionIsEffect,
        dirtyBefore,
        isOwnCommitSource,
        hasSourceChangeGroup,
        actionChangeGroup,
        sourceChangeGroup,
      });
      const scheduledEffects: TriggerTraceScheduledEffect[] =
        applyPullTriggeredActionPlan(
          state,
          action,
          actionIsEffect,
          plan,
        );

      triggerTraceEntry?.triggered.push(
        createTriggerTraceActionRecord({
          actionId,
          actionType,
          mode: "pull",
          decision: plan.decision,
          pendingBefore,
          pendingAfter: state.pending.has(action),
          dirtyBefore,
          dirtyAfter: state.dirty.has(action),
          scheduledEffects,
        }),
      );
    }

    if (
      triggerTraceEntry &&
      shouldRecordTriggerTraceEntry(triggerTraceEntry)
    ) {
      state.recordTriggerTrace(triggerTraceEntry);
    }
  }
}
