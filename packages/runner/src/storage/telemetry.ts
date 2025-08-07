import type { RuntimeTelemetry } from "../telemetry.ts";
import type * as Inspector from "./inspector.ts";

/**
 * StorageTelemetry bridges storage inspector operations with the RuntimeTelemetry system.
 * It tracks state changes in the Inspector Model and converts them to telemetry events.
 */
export class StorageTelemetry {
  private telemetry: RuntimeTelemetry;
  private previousPush: Inspector.PushState = {};
  private previousPull: Inspector.PullState = {};
  private previousSubscriptions: Record<string, any> = {};
  private previousConnection?: Inspector.Status<any>;

  constructor(telemetry: RuntimeTelemetry) {
    this.telemetry = telemetry;
  }

  /**
   * Track storage state changes through telemetry events.
   * Compares before and after states to detect changes and emit appropriate events.
   */
  trackStateChange(
    before: Inspector.Model,
    after: Inspector.Model,
    command: Inspector.BroadcastCommand
  ) {
    // Track connection status updates
    if (
      JSON.stringify(before.connection) !== JSON.stringify(after.connection)
    ) {
      let status: "pending" | "ok" | "error";
      let attempt = 0;
      
      if (after.connection.pending) {
        // Connection is pending
        status = "pending";
        // The pending field contains a Result which may have error or ok status
        if (after.connection.pending.error) {
          status = "error";
        } else if (after.connection.pending.ok) {
          // Extract attempt from the Connect object if available
          attempt = after.connection.pending.ok.attempt ?? 0;
        }
      } else if (after.connection.ready) {
        // Connection is ready
        if (after.connection.ready.error) {
          status = "error";
        } else {
          status = "ok";
        }
      } else {
        // Default to pending if neither pending nor ready
        status = "pending";
      }
      
      this.telemetry.submit({
        type: "storage.connection.update",
        status,
        attempt,
      });
    }

    // Track push operation changes
    this.trackPushChanges(before.push, after.push);

    // Track pull operation changes
    this.trackPullChanges(before.pull, after.pull);

    // Track subscription changes
    this.trackSubscriptionChanges(before.subscriptions, after.subscriptions);

    // Track new operations initiated via send command
    if (command.send) {
      const [id] = Object.keys(command.send.authorization.access);
      const url = `job:${id}`;
      
      this.telemetry.submit({
        type: "storage.push.start",
        id: url,
        operation: "send",
      });
    }
  }

  private trackPushChanges(
    before: Inspector.PushState,
    after: Inspector.PushState
  ) {
    // Check for new operations
    for (const [id, state] of Object.entries(after)) {
      if (!before[id]) {
        // New operation started
        this.telemetry.submit({
          type: "storage.push.start",
          id,
          operation: "push",
        });
      } else if (before[id] !== state) {
        // State changed
        if (state.error) {
          this.telemetry.submit({
            type: "storage.push.error",
            id,
            error: String(state.error),
          });
        } else if (state.ok) {
          this.telemetry.submit({
            type: "storage.push.complete",
            id,
            success: true,
          });
        }
      }
    }

    // Check for removed operations (completed or cancelled)
    for (const id of Object.keys(before)) {
      if (!after[id]) {
        // Operation was removed, assume completion if no error was tracked
        if (!before[id].error) {
          this.telemetry.submit({
            type: "storage.push.complete",
            id,
            success: true,
          });
        }
      }
    }
  }

  private trackPullChanges(
    before: Inspector.PullState,
    after: Inspector.PullState
  ) {
    // Check for new operations
    for (const [id, state] of Object.entries(after)) {
      if (!before[id]) {
        // New operation started
        this.telemetry.submit({
          type: "storage.pull.start",
          id,
          operation: "pull",
        });
      } else if (before[id] !== state) {
        // State changed
        if (state.error) {
          this.telemetry.submit({
            type: "storage.pull.error",
            id,
            error: String(state.error),
          });
        } else if (state.ok) {
          this.telemetry.submit({
            type: "storage.pull.complete",
            id,
            success: true,
          });
        }
      }
    }

    // Check for removed operations (completed or cancelled)
    for (const id of Object.keys(before)) {
      if (!after[id]) {
        // Operation was removed, assume completion if no error was tracked
        if (!before[id].error) {
          this.telemetry.submit({
            type: "storage.pull.complete",
            id,
            success: true,
          });
        }
      }
    }
  }

  private trackSubscriptionChanges(
    before: Record<string, any>,
    after: Record<string, any>
  ) {
    // Check for new subscriptions
    for (const id of Object.keys(after)) {
      if (!before[id]) {
        this.telemetry.submit({
          type: "storage.subscription.add",
          id,
        });
      }
    }

    // Check for removed subscriptions
    for (const id of Object.keys(before)) {
      if (!after[id]) {
        this.telemetry.submit({
          type: "storage.subscription.remove",
          id,
        });
      }
    }
  }

  /**
   * Clear all tracked state
   */
  clear() {
    this.previousPush = {};
    this.previousPull = {};
    this.previousSubscriptions = {};
    this.previousConnection = undefined;
  }
}