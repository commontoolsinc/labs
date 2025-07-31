import * as Inspector from "@commontools/runner/storage/inspector";

export class StorageInspectorUpdateEvent
  extends CustomEvent<{ model: StorageInspectorState }> {
  constructor(model: StorageInspectorState) {
    super("inspectorupdate", {
      detail: {
        model,
      },
    });
  }
}

export type StorageInspectorConflicts = {
  push: Inspector.PushStateValue[];
  pull: Inspector.PullStateValue[];
};

export class StorageInspectorState extends Inspector.Model {
  // Keep a history of completed operations for display
  private pushHistory: Map<string, Inspector.PushStateValue> = new Map();
  private pullHistory: Map<string, Inspector.PullStateValue> = new Map();
  private readonly MAX_HISTORY = 100;

  // Track creation times for operations
  private operationTimes: Map<string, number> = new Map();

  constructor(time = Date.now()) {
    super(
      { pending: { ok: { attempt: 0 } }, time },
      {},
      {},
      {},
    );
  }

  update(command: Inspector.BroadcastCommand) {
    // Store current operations before update
    const beforePush = { ...this.push };
    const beforePull = { ...this.pull };

    // Track new operations and their creation times
    if (command.send) {
      const [id] = Object.keys(command.send.authorization.access);
      const url = `job:${id}`;
      this.operationTimes.set(url, command.time);
    }

    const updatedState = Inspector.update(this, command);

    // Check for completed operations (ones that were removed)
    for (const [id, value] of Object.entries(beforePush)) {
      if (!updatedState.push[id] && !value.error) {
        // Operation completed successfully, add to history
        this.pushHistory.set(id, value);
        this.trimHistory(this.pushHistory);
      }
    }

    for (const [id, value] of Object.entries(beforePull)) {
      if (!updatedState.pull[id] && !value.error) {
        // Operation completed successfully, add to history
        this.pullHistory.set(id, value);
        this.trimHistory(this.pullHistory);
      }
    }

    // Clean up operation times for completed operations
    const allCurrentIds = new Set([
      ...Object.keys(updatedState.push),
      ...Object.keys(updatedState.pull),
    ]);
    for (const [id] of this.operationTimes) {
      if (
        !allCurrentIds.has(id) && !this.pushHistory.has(id) &&
        !this.pullHistory.has(id)
      ) {
        this.operationTimes.delete(id);
      }
    }

    // Inspector.update returns a new state, we need to copy its properties
    this.connection = updatedState.connection;
    this.push = updatedState.push;
    this.pull = updatedState.pull;
    this.subscriptions = updatedState.subscriptions;
  }

  private trimHistory<T>(history: Map<string, T>) {
    if (history.size > this.MAX_HISTORY) {
      const entries = Array.from(history.entries());
      // Remove oldest entries
      for (let i = 0; i < entries.length - this.MAX_HISTORY; i++) {
        history.delete(entries[i][0]);
      }
    }
  }

  // Get all operations including history
  getAllPush(): Record<string, Inspector.PushStateValue> {
    const all: Record<string, Inspector.PushStateValue> = {};
    // Add history first (older)
    for (const [id, value] of this.pushHistory) {
      all[id] = value;
    }
    // Add current operations (newer/in-progress)
    Object.assign(all, this.push);
    return all;
  }

  getAllPull(): Record<string, Inspector.PullStateValue> {
    const all: Record<string, Inspector.PullStateValue> = {};
    // Add history first (older)
    for (const [id, value] of this.pullHistory) {
      all[id] = value;
    }
    // Add current operations (newer/in-progress)
    Object.assign(all, this.pull);
    return all;
  }

  getErrors(): StorageInspectorConflicts | undefined {
    const push = Object.values(this.push).filter(
      (v) => v.error,
    );
    const pull = Object.values(this.pull).filter(
      (v) => v.error,
    );

    if (push.length === 0 && pull.length === 0) {
      return;
    }
    return { push, pull };
  }

  // Get the creation time for an operation
  getOperationTime(id: string): number | undefined {
    return this.operationTimes.get(id);
  }

  // Clear all operations (both history and active)
  clearAll() {
    // Clear history
    this.pushHistory.clear();
    this.pullHistory.clear();

    // Clear current active operations
    this.push = {};
    this.pull = {};

    // Clear all operation times
    this.operationTimes.clear();
  }
}
