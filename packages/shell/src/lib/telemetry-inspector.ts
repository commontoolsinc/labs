import type {
  RuntimeTelemetryMarkerResult,
} from "@commontools/runner";

/**
 * Storage operation derived from telemetry events
 */
export interface StorageOperation {
  id: string;
  type: "push" | "pull";
  status: "active" | "completed" | "error";
  startTime: number;
  endTime?: number;
  error?: string;
  operation?: string;
}

/**
 * Connection status derived from telemetry
 */
export interface ConnectionStatus {
  status: "pending" | "ok" | "error";
  attempt: number;
  lastUpdate: number;
}

/**
 * Derived state from telemetry events
 */
export interface TelemetryDerivedState {
  activeOperations: Map<string, StorageOperation>;
  completedOperations: StorageOperation[];
  errors: StorageOperation[];
  connectionStatus: ConnectionStatus;
  subscriptions: Set<string>;
}

/**
 * TelemetryBasedInspector processes RuntimeTelemetry events to derive
 * storage operation state for visualization.
 * 
 * This provides a pure, reproducible state from the telemetry event stream,
 * allowing for time-travel debugging and event replay.
 */
export class TelemetryBasedInspector {
  private telemetryMarkers: RuntimeTelemetryMarkerResult[];
  private derivedState: TelemetryDerivedState;
  private readonly MAX_HISTORY = 100;

  constructor() {
    this.telemetryMarkers = [];
    this.derivedState = {
      activeOperations: new Map(),
      completedOperations: [],
      errors: [],
      connectionStatus: { status: "pending", attempt: 0, lastUpdate: Date.now() },
      subscriptions: new Set(),
    };
  }

  /**
   * Process telemetry markers to derive current state.
   * This rebuilds the entire state from the event stream.
   */
  processMarkers(markers: RuntimeTelemetryMarkerResult[]) {
    this.telemetryMarkers = markers;
    this.rebuildState();
  }

  /**
   * Rebuild state from telemetry markers.
   * This provides a pure function approach to state derivation.
   */
  private rebuildState() {
    // Reset state
    const operations = new Map<string, StorageOperation>();
    const completed: StorageOperation[] = [];
    const errors: StorageOperation[] = [];
    const subscriptions = new Set<string>();
    let connectionStatus: ConnectionStatus = {
      status: "pending",
      attempt: 0,
      lastUpdate: Date.now(),
    };

    // Process all markers in order
    for (const marker of this.telemetryMarkers) {
      switch (marker.type) {
        case "storage.push.start":
        case "storage.pull.start": {
          const type = marker.type.includes("push") ? "push" : "pull";
          operations.set(marker.id, {
            id: marker.id,
            type,
            status: "active",
            startTime: marker.timeStamp,
            operation: marker.operation,
          });
          break;
        }

        case "storage.push.complete":
        case "storage.pull.complete": {
          const op = operations.get(marker.id);
          if (op) {
            op.status = "completed";
            op.endTime = marker.timeStamp;
            completed.push(op);
            operations.delete(marker.id);
          }
          break;
        }

        case "storage.push.error":
        case "storage.pull.error": {
          const op = operations.get(marker.id);
          if (op) {
            op.status = "error";
            op.error = marker.error;
            op.endTime = marker.timeStamp;
            errors.push(op);
            operations.delete(marker.id);
          } else {
            // Create error entry even if we didn't track the start
            const type = marker.type.includes("push") ? "push" : "pull";
            errors.push({
              id: marker.id,
              type,
              status: "error",
              startTime: marker.timeStamp,
              endTime: marker.timeStamp,
              error: marker.error,
            });
          }
          break;
        }

        case "storage.connection.update": {
          connectionStatus = {
            status: marker.status,
            attempt: marker.attempt,
            lastUpdate: marker.timeStamp,
          };
          break;
        }

        case "storage.subscription.add": {
          subscriptions.add(marker.id);
          break;
        }

        case "storage.subscription.remove": {
          subscriptions.delete(marker.id);
          break;
        }
      }
    }

    // Trim history to max size
    if (completed.length > this.MAX_HISTORY) {
      completed.splice(0, completed.length - this.MAX_HISTORY);
    }
    if (errors.length > this.MAX_HISTORY) {
      errors.splice(0, errors.length - this.MAX_HISTORY);
    }

    // Update derived state
    this.derivedState = {
      activeOperations: operations,
      completedOperations: completed,
      errors,
      connectionStatus,
      subscriptions,
    };
  }

  /**
   * Get the current derived state
   */
  getState(): TelemetryDerivedState {
    return this.derivedState;
  }

  /**
   * Get all operations (active + completed + errors)
   */
  getAllOperations(): StorageOperation[] {
    return [
      ...this.derivedState.activeOperations.values(),
      ...this.derivedState.completedOperations,
      ...this.derivedState.errors,
    ];
  }

  /**
   * Get operations of a specific type
   */
  getOperationsByType(type: "push" | "pull"): StorageOperation[] {
    return this.getAllOperations().filter(op => op.type === type);
  }

  /**
   * Get operations by status
   */
  getOperationsByStatus(status: "active" | "completed" | "error"): StorageOperation[] {
    switch (status) {
      case "active":
        return Array.from(this.derivedState.activeOperations.values());
      case "completed":
        return this.derivedState.completedOperations;
      case "error":
        return this.derivedState.errors;
    }
  }

  /**
   * Check if there are any active operations
   */
  hasActiveOperations(): boolean {
    return this.derivedState.activeOperations.size > 0;
  }

  /**
   * Get telemetry markers for a specific operation
   */
  getOperationMarkers(operationId: string): RuntimeTelemetryMarkerResult[] {
    return this.telemetryMarkers.filter(marker => {
      if ("id" in marker && marker.id === operationId) {
        return true;
      }
      return false;
    });
  }

  /**
   * Clear all state
   */
  clear() {
    this.telemetryMarkers = [];
    this.derivedState = {
      activeOperations: new Map(),
      completedOperations: [],
      errors: [],
      connectionStatus: { status: "pending", attempt: 0, lastUpdate: Date.now() },
      subscriptions: new Set(),
    };
  }
}