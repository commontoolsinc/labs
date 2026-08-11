import type { Cancel } from "../cancel.ts";
import { noOp } from "../cancel.ts";

export interface InitialRunGate {
  isReleased(): boolean;
  status(): InitialRunGateStatus;
  onRelease(callback: () => void): Cancel;
  onSettle(
    callback: (status: Exclude<InitialRunGateStatus, "pending">) => void,
  ): Cancel;
}

export type InitialRunGateStatus = "pending" | "released" | "cancelled";

export interface InitialRunGateController {
  gate: InitialRunGate;
  release(): void;
  cancel(): void;
}

/**
 * Hold newly registered actions until the caller releases their first run.
 */
export function createInitialRunGate(): InitialRunGateController {
  let state: InitialRunGateStatus = "pending";
  const callbacks = new Set<() => void>();
  const settleCallbacks = new Set<
    (status: Exclude<InitialRunGateStatus, "pending">) => void
  >();

  const gate: InitialRunGate = {
    isReleased: () => state === "released",
    status: () => state,
    onRelease(callback) {
      if (state === "released") {
        callback();
        return noOp;
      }
      if (state === "cancelled") return noOp;
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    onSettle(callback) {
      if (state !== "pending") {
        callback(state);
        return noOp;
      }
      settleCallbacks.add(callback);
      return () => settleCallbacks.delete(callback);
    },
  };

  const settle = (status: Exclude<InitialRunGateStatus, "pending">) => {
    const pendingCallbacks = [...settleCallbacks];
    settleCallbacks.clear();
    const errors: unknown[] = [];
    for (const callback of pendingCallbacks) {
      try {
        callback(status);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  return {
    gate,
    release() {
      if (state !== "pending") return;
      state = "released";
      const pendingCallbacks = [...callbacks];
      callbacks.clear();
      const errors = settle("released");
      for (const callback of pendingCallbacks) {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Multiple initial-run gate callbacks failed",
        );
      }
    },
    cancel() {
      if (state !== "pending") return;
      state = "cancelled";
      callbacks.clear();
      const errors = settle("cancelled");
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Multiple initial-run gate callbacks failed",
        );
      }
    },
  };
}
