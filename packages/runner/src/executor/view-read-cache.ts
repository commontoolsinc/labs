import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import { SchedulerTriggerIndex } from "../scheduler/trigger-index.ts";
import type { Action } from "../scheduler/types.ts";
import type {
  StorageNotification,
  TransactionReactivityLog,
} from "../storage/interface.ts";

/** Retains a planner result until its observed reads change under its identity. */
export class ViewReadCache<Value> {
  #index: SchedulerTriggerIndex;
  #reader: Action = () => {};
  #value: Value | undefined;

  /** Binds dependency matching to the viewing session's scope instances. */
  constructor(identity: ScopeKeyIdentity) {
    this.#index = new SchedulerTriggerIndex(() => identity);
  }

  /** Cached result, absent after an observed change or before the first read. */
  get value(): Value | undefined {
    return this.#value;
  }

  /** Replaces the result and its recursive and shallow read dependencies. */
  set(
    value: Value,
    log: Pick<TransactionReactivityLog, "reads" | "shallowReads">,
  ): void {
    this.#index.clear();
    this.#index.addActionReads(
      this.#reader,
      sortAndCompactPaths(log.reads),
      sortAndCompactPaths(log.shallowReads, false),
    );
    this.#value = value;
  }

  /** Invalidates the result using the scheduler's value and path change rules. */
  notify(notification: StorageNotification): void {
    if (this.#value === undefined) return;
    if (notification.type === "reset") {
      this.#value = undefined;
      return;
    }
    for (const change of notification.changes) {
      if (
        this.#index.collectTriggeredActionsForChange(
          notification.space,
          change,
        ).triggeredActions.length > 0
      ) {
        this.#value = undefined;
        return;
      }
    }
  }
}
