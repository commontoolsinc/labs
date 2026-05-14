import { getLogger } from "@commonfabric/utils/logger";
import { recordTrustedEventPolicyInputs } from "../cfc/ui-contract.ts";
import type { Runtime } from "../runtime.ts";
import {
  hasAnnotatedWrites,
  trustedEventWriteCandidatesFromTransaction,
} from "./reactivity.ts";
import type { Action, EventHandler, QueuedEvent } from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export async function dispatchQueuedEvent(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (handler: EventHandler) =>
    | {
      patternName?: string;
      moduleName?: string;
      reads?: string[];
      writes?: string[];
    }
    | undefined;
  readonly handleError: (error: Error, action: Action) => void;
  readonly queueExecution: () => void;
}, queuedEvent: QueuedEvent): Promise<void> {
  const { action, handler, event: eventValue, retriesLeft, onCommit } =
    queuedEvent;
  const handlerId = state.getActionId(handler);

  state.runtime.telemetry.submit({
    type: "scheduler.invocation",
    handlerId,
    handlerInfo: state.getActionTelemetryInfo(handler),
  });
  state.eventQueue.shift();

  const tx = state.runtime.edit();
  tx.tx.immediate = true;
  const actionId = state.getActionId(action);
  const runFinalCommitCallback = () => {
    if (!onCommit) {
      return;
    }
    try {
      onCommit(tx);
    } catch (callbackError) {
      logger.error(
        "schedule-error",
        "Error in event commit callback:",
        callbackError,
      );
    }
  };

  const finalize = (error?: unknown) => {
    if (error) {
      try {
        state.handleError(error as Error, action);
      } finally {
        if (tx.status().status === "ready") {
          tx.abort(error);
        }
      }
      return;
    }

    state.runtime.prepareTxForCommit(tx);
    tx.commit().then((result) => {
      if (result.error && retriesLeft > 0) {
        logger.warn(
          "scheduler",
          `Event handler transaction failed, retrying (${retriesLeft} retries left)`,
          { error: result.error, handlerId },
        );
        state.eventQueue.unshift({
          action,
          eventLink: queuedEvent.eventLink,
          handler,
          event: eventValue,
          retriesLeft: retriesLeft - 1,
          onCommit,
        });
        state.queueExecution();
        return;
      }
      runFinalCommitCallback();
      if (result.error) {
        logger.error(
          "schedule-error",
          "Event handler transaction failed after exhausting all retries",
          { error: result.error, handlerId },
        );
      }
    }).catch((error) => {
      logger.error(
        "schedule-error",
        "Event handler commit promise rejected:",
        error,
      );
    });
  };

  try {
    if (hasAnnotatedWrites(handler)) {
      recordTrustedEventPolicyInputs(tx, handler.writes, eventValue);
    }
    const actionStartTime = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "handlerAction",
    );
    try {
      const runningPromise = Promise.resolve(
        state.runtime.harness.invoke(() => action(tx)),
      ).then(() => {
        const trustedEventCandidates =
          trustedEventWriteCandidatesFromTransaction(tx, handler, [
            queuedEvent.eventLink.space,
          ]);
        recordTrustedEventPolicyInputs(
          tx,
          trustedEventCandidates,
          eventValue,
        );
        const duration = (performance.now() - actionStartTime) / 1000;
        if (duration > 10) {
          console.warn(`Slow action: ${duration.toFixed(3)}s`, action);
        }
        logger.debug("action-timing", () => {
          return [
            `Action ${actionId} completed in ${duration.toFixed(3)}s`,
          ];
        });
        finalize();
      }).catch((error) => finalize(error));
      state.setRunningPromise(runningPromise);
      await runningPromise;
    } finally {
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "handlerAction",
      );
    }
  } catch (error) {
    finalize(error);
  }
}
