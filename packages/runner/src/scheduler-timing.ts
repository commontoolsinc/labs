import { getLogger } from "@commontools/utils/logger";
import type { Action, EventHandler } from "./scheduler.ts";
import type { ActionStats } from "./telemetry.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
const AUTO_DEBOUNCE_MIN_RUNS = 3;
const AUTO_DEBOUNCE_DELAY_MS = 100;

// Cycle-aware debounce: applies adaptive debounce to actions cycling within one execute()
const CYCLE_DEBOUNCE_THRESHOLD_MS = 100;
const CYCLE_DEBOUNCE_MIN_RUNS = 3;
const CYCLE_DEBOUNCE_MULTIPLIER = 2;

/**
 * Delegate that owns all timing-related state and logic for the Scheduler:
 * action stats, debounce, throttle, and cycle-aware debounce.
 *
 * The Scheduler passes a narrow interface via the constructor; the delegate
 * never holds a reference to the full Scheduler.
 */
export class SchedulerTiming {
  // ── Action Stats ──────────────────────────────────────────────────────

  private actionStats = new Map<string, ActionStats>();

  // ── Debounce ──────────────────────────────────────────────────────────

  private debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  /** All live debounce timers — kept for cleanup in dispose(). */
  private activeDebounceTimers = new Set<ReturnType<typeof setTimeout>>();
  private actionDebounce = new WeakMap<Action, number>();
  /** Actions that opted OUT of auto-debounce. */
  private noDebounce = new WeakMap<Action, boolean>();

  // ── Throttle ──────────────────────────────────────────────────────────

  private actionThrottle = new WeakMap<Action, number>();

  // ── Cycle-aware debounce (per execute() call) ─────────────────────────

  private runsThisExecute = new Map<Action, number>();
  private executeStartTime = 0;

  constructor(
    private getActionId: (a: Action | EventHandler) => string,
    private addPending: (a: Action) => void,
    private queueExecution: () => void,
  ) {}

  // ── Action Stats ──────────────────────────────────────────────────────

  /**
   * Records the execution time for an action.
   * Updates running statistics including run count, total time, and average time.
   * Stats are keyed by action ID (source location) to persist across action recreation.
   */
  recordActionTime(action: Action, elapsed: number): void {
    const now = performance.now();
    const actionId = this.getActionId(action);
    const existing = this.actionStats.get(actionId);
    if (existing) {
      existing.runCount++;
      existing.totalTime += elapsed;
      existing.averageTime = existing.totalTime / existing.runCount;
      existing.lastRunTime = elapsed;
      existing.lastRunTimestamp = now;
    } else {
      this.actionStats.set(actionId, {
        runCount: 1,
        totalTime: elapsed,
        averageTime: elapsed,
        lastRunTime: elapsed,
        lastRunTimestamp: now,
      });
    }

    // Check if action should be auto-debounced based on performance
    this.maybeAutoDebounce(action);
  }

  /**
   * Returns the execution statistics for an action, if available.
   * Accepts either an Action or an action ID string.
   */
  getActionStats(action: Action | string): ActionStats | undefined {
    const actionId = typeof action === "string"
      ? action
      : this.getActionId(action);
    return this.actionStats.get(actionId);
  }

  /** Iterate all recorded stats (used by graph snapshot). */
  allStats(): IterableIterator<[string, ActionStats]> {
    return this.actionStats.entries();
  }

  // ── Debounce ──────────────────────────────────────────────────────────

  /**
   * Sets a debounce delay for an action.
   * When the action is triggered, it will wait for the specified delay before running.
   * If triggered again during the delay, the timer resets.
   */
  setDebounce(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionDebounce.delete(action);
    } else {
      this.actionDebounce.set(action, ms);
    }
  }

  /** Gets the current debounce delay for an action, if set. */
  getDebounce(action: Action): number | undefined {
    return this.actionDebounce.get(action);
  }

  /** Clears the debounce setting for an action. */
  clearDebounce(action: Action): void {
    this.actionDebounce.delete(action);
    this.cancelDebounceTimer(action);
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    if (optOut) {
      this.noDebounce.set(action, true);
    } else {
      this.noDebounce.delete(action);
    }
  }

  /** Returns true if this action has opted out of auto-debounce. */
  hasNoDebounce(action: Action): boolean {
    return this.noDebounce.get(action) === true;
  }

  /** Cancels any pending debounce timer for an action. */
  cancelDebounceTimer(action: Action): void {
    const timer = this.debounceTimers.get(action);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
    }
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  scheduleWithDebounce(action: Action): void {
    const debounceMs = this.actionDebounce.get(action);

    if (!debounceMs || debounceMs <= 0) {
      // No debounce - add immediately
      this.addPending(action);
      this.queueExecution();
      return;
    }

    // Clear existing timer if any
    this.cancelDebounceTimer(action);

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      this.addPending(action);
      this.queueExecution();
    }, debounceMs);

    this.debounceTimers.set(action, timer);
    this.activeDebounceTimers.add(timer);

    logger.debug("schedule-debounce", () => [
      `[DEBOUNCE] Action ${
        this.getActionId(action)
      } debounced for ${debounceMs}ms`,
    ]);
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   */
  private maybeAutoDebounce(action: Action): void {
    if (this.noDebounce.get(action)) return;
    if (this.actionDebounce.has(action)) return;

    const stats = this.actionStats.get(this.getActionId(action));
    if (!stats) return;

    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return;

    if (stats.averageTime >= AUTO_DEBOUNCE_THRESHOLD_MS) {
      this.actionDebounce.set(action, AUTO_DEBOUNCE_DELAY_MS);
      const actionId = this.getActionId(action);
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${actionId} ` +
        `auto-debounced (avg ${
          stats.averageTime.toFixed(1)
        }ms >= ${AUTO_DEBOUNCE_THRESHOLD_MS}ms)`,
      ]);
    }
  }

  // ── Throttle ──────────────────────────────────────────────────────────

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   */
  setThrottle(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionThrottle.delete(action);
    } else {
      this.actionThrottle.set(action, ms);
    }
  }

  /** Gets the throttle period for an action, if set. */
  getThrottle(action: Action): number | undefined {
    return this.actionThrottle.get(action);
  }

  /** Clears the throttle setting for an action. */
  clearThrottle(action: Action): void {
    this.actionThrottle.delete(action);
  }

  /**
   * Returns true if the action is currently throttled
   * (ran recently within its throttle window).
   */
  isThrottled(action: Action): boolean {
    const throttleMs = this.actionThrottle.get(action);
    if (!throttleMs || throttleMs <= 0) return false;

    const stats = this.actionStats.get(this.getActionId(action));
    if (!stats?.lastRunTimestamp) return false;

    return (performance.now() - stats.lastRunTimestamp) < throttleMs;
  }

  // ── Cycle-aware debounce ──────────────────────────────────────────────

  /** Call at the start of each execute() cycle. */
  beginExecuteCycle(): void {
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();
  }

  /** Record that an action ran once during the current execute() cycle. */
  recordRunInCycle(action: Action): void {
    this.runsThisExecute.set(
      action,
      (this.runsThisExecute.get(action) ?? 0) + 1,
    );
  }

  /**
   * Call at the end of each execute() cycle (in pull mode).
   * Applies adaptive debounce to actions that ran multiple times.
   */
  applyCycleDebounce(pullMode: boolean): void {
    const executeElapsed = performance.now() - this.executeStartTime;
    if (pullMode && executeElapsed >= CYCLE_DEBOUNCE_THRESHOLD_MS) {
      for (const [action, runs] of this.runsThisExecute) {
        if (runs >= CYCLE_DEBOUNCE_MIN_RUNS && !this.noDebounce.get(action)) {
          const adaptiveDelay = Math.round(
            CYCLE_DEBOUNCE_MULTIPLIER * executeElapsed,
          );
          const currentDebounce = this.actionDebounce.get(action) ?? 0;
          if (adaptiveDelay > currentDebounce) {
            this.actionDebounce.set(action, adaptiveDelay);
            logger.debug("schedule-cycle-debounce", () => [
              `[CYCLE-DEBOUNCE] Action ${this.getActionId(action)} ` +
              `ran ${runs}x in ${executeElapsed.toFixed(1)}ms, ` +
              `setting debounce to ${adaptiveDelay}ms`,
            ]);
          }
        }
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /** Clear all debounce timers. Called by Scheduler.dispose(). */
  dispose(): void {
    for (const timer of this.activeDebounceTimers) {
      clearTimeout(timer);
    }
    this.activeDebounceTimers.clear();
  }
}
