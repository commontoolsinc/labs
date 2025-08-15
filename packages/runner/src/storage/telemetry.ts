import type { RuntimeTelemetry } from "../telemetry.ts";
import * as Inspector from "./inspector.ts";

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
   * Process an inspector command directly and emit appropriate telemetry events.
   * Maintains internal state to track changes.
   */
  processCommand(command: Inspector.BroadcastCommand) {
    // Update our internal model with the command
    const before = {
      connection: this.previousConnection ||
        { pending: { ok: { attempt: 0 } }, time: Date.now() },
      push: this.previousPush,
      pull: this.previousPull,
      subscriptions: this.previousSubscriptions,
    };

    const after = Inspector.update(before as Inspector.Model, command);

    // Track state changes
    this.trackStateChange(before as Inspector.Model, after, command);

    // Update our cached state
    this.previousConnection = after.connection;
    this.previousPush = after.push;
    this.previousPull = after.pull;
    this.previousSubscriptions = after.subscriptions;
  }

  private trackStateChange(
    before: Inspector.Model,
    after: Inspector.Model,
    command: Inspector.BroadcastCommand,
  ) {
    if (
      JSON.stringify(before.connection) !== JSON.stringify(after.connection)
    ) {
      const status: "pending" | "ok" | "error" = after.connection.ready?.ok
        ? "ok"
        : after.connection.ready?.error
        ? "error"
        : "pending";

      const attempt = after.connection.pending?.ok?.attempt ?? 0;

      this.telemetry.submit({
        type: "storage.connection.update",
        status,
        attempt,
      });
    }

    this.trackPushChanges(before.push, after.push);
    this.trackPullChanges(before.pull, after.pull);
    this.trackSubscriptionChanges(before.subscriptions, after.subscriptions);

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
    after: Inspector.PushState,
  ) {
    for (const [id, state] of Object.entries(after)) {
      if (!before[id]) {
        this.telemetry.submit({
          type: "storage.push.start",
          id,
          operation: "push",
        });
      } else if (before[id] !== state) {
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
          });
        }
      }
    }

    for (const id of Object.keys(before)) {
      if (!after[id]) {
        if (!before[id].error) {
          this.telemetry.submit({
            type: "storage.push.complete",
            id,
          });
        }
      }
    }
  }

  private trackPullChanges(
    before: Inspector.PullState,
    after: Inspector.PullState,
  ) {
    for (const [id, state] of Object.entries(after)) {
      if (!before[id]) {
        this.telemetry.submit({
          type: "storage.pull.start",
          id,
          operation: "pull",
        });
      } else if (before[id] !== state) {
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
          });
        }
      }
    }

    for (const id of Object.keys(before)) {
      if (!after[id]) {
        if (!before[id].error) {
          this.telemetry.submit({
            type: "storage.pull.complete",
            id,
          });
        }
      }
    }
  }

  private trackSubscriptionChanges(
    before: Record<string, any>,
    after: Record<string, any>,
  ) {
    for (const id of Object.keys(after)) {
      if (!before[id]) {
        this.telemetry.submit({
          type: "storage.subscription.add",
          id,
        });
      }
    }

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
