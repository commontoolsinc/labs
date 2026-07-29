import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { InitialRunGateController } from "../scheduler/initial-run-gate.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  isConflictRejection,
  isStorageTransactionInconsistent,
} from "../storage/rejection.ts";

type ElementRun = { resultCell: Cell<any>; lastIndex: number };
type ElementRuns = Map<string, ElementRun>;

interface ElementIntent {
  sequence: number;
  present: boolean;
  lastIndex: number;
}

interface ElementState {
  elementKey: string;
  elementRun: ElementRun;
  release?: () => boolean;
  initialRunGate?: InitialRunGateController;
  successful?: ElementIntent;
  // A present setup kept for the scheduler's next stale-basis attempt.
  stalePresent?: ElementIntent;
  pending: Map<number, ElementIntent>;
  disposed: boolean;
}

interface ReconcileCommit {
  sequence: number;
  changes: Map<string, { state: ElementState; intent: ElementIntent }>;
  ignored: boolean;
  settled: boolean;
}

export interface ElementRunCommitGuard {
  /** Register one reconcile and report whether it may change child ownership. */
  begin(sourceTx: IExtendedStorageTransaction): boolean;

  /** Whether this element's setup must be included in the current reconcile. */
  needsPresentSetup(
    elementKey: string,
    resultCell: Cell<any>,
    lastIndex: number,
    indexAffectsSetup: boolean,
  ): boolean;

  /** Record that this reconcile durably defines an element run. */
  trackPresent(
    sourceTx: IExtendedStorageTransaction,
    elementKey: string,
    resultCell: Cell<any>,
    lastIndex: number,
    options?: {
      created?: boolean;
      release?: () => boolean;
      initialRunGate?: InitialRunGateController;
    },
  ): void;

  /** Record that this reconcile removes an element run. */
  trackRemoval(
    sourceTx: IExtendedStorageTransaction,
    elementKey: string,
    resultCell: Cell<any>,
  ): void;

  /** Settle an action attempt whose transaction was aborted before commit. */
  abort(sourceTx: IExtendedStorageTransaction): void;

  /** Cancel pending gates and release every child owned by the coordinator. */
  cancel(): void;
}

/**
 * Keep a list coordinator's child registry aligned with successful commits.
 */
export function createElementRunCommitGuard(opts: {
  runtime: Runtime;
  elementRuns: ElementRuns;
}): ElementRunCommitGuard {
  const { runtime, elementRuns } = opts;
  const commits = new WeakMap<
    IExtendedStorageTransaction,
    ReconcileCommit
  >();
  const states = new Map<string, ElementState>();
  let nextSequence = 1;
  let active = true;

  const isStaleBasis = (error: unknown): boolean => {
    const rejection = error as { name?: string } | undefined;
    return isConflictRejection(rejection) ||
      isStorageTransactionInconsistent(rejection);
  };

  const throwCleanupErrors = (errors: unknown[]): void => {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple list child cleanups failed");
    }
  };

  const disposeState = (state: ElementState): void => {
    if (state.disposed) return;
    state.disposed = true;
    const errors: unknown[] = [];
    let stopped = true;
    try {
      if (state.release) {
        stopped = state.release();
      } else {
        runtime.runner.releaseChild(state.elementRun.resultCell, undefined);
      }
    } catch (error) {
      errors.push(error);
      if (state.release) {
        try {
          stopped = state.release();
        } catch (outcomeError) {
          errors.push(outcomeError);
        }
      }
    }
    try {
      if (stopped) {
        state.initialRunGate?.cancel();
      } else {
        state.initialRunGate?.release();
      }
    } catch (error) {
      errors.push(error);
    }
    if (elementRuns.get(state.elementKey) === state.elementRun) {
      elementRuns.delete(state.elementKey);
    }
    if (states.get(state.elementKey) === state) {
      states.delete(state.elementKey);
    }
    throwCleanupErrors(errors);
  };

  const reconcileState = (state: ElementState): void => {
    if (state.disposed) return;
    const successfulSequence = state.successful?.sequence ?? 0;
    const staleSequence = state.stalePresent?.sequence ?? 0;
    const settledSequence = Math.max(successfulSequence, staleSequence);
    const hasLaterPending = [...state.pending.keys()].some((sequence) =>
      sequence > settledSequence
    );

    if (state.successful?.present) {
      state.elementRun.lastIndex = state.successful.lastIndex;
      state.initialRunGate?.release();
    }
    if (hasLaterPending) return;
    if (!state.successful?.present && !state.stalePresent?.present) {
      disposeState(state);
    }
  };

  const settle = (
    sourceTx: IExtendedStorageTransaction,
    committed: boolean,
    error?: unknown,
  ): void => {
    const commit = commits.get(sourceTx);
    if (!commit || commit.settled) return;
    commit.settled = true;

    const errors: unknown[] = [];
    for (const { state, intent } of commit.changes.values()) {
      state.pending.delete(commit.sequence);
      if (
        committed &&
        !state.disposed &&
        (state.successful?.sequence ?? 0) < intent.sequence
      ) {
        state.successful = intent;
      }
      if (
        committed &&
        (state.stalePresent?.sequence ?? 0) <= intent.sequence
      ) {
        state.stalePresent = undefined;
      } else if (
        !committed &&
        !state.disposed &&
        intent.present &&
        isStaleBasis(error) &&
        (state.successful?.sequence ?? 0) < intent.sequence &&
        (state.stalePresent?.sequence ?? 0) < intent.sequence
      ) {
        state.stalePresent = intent;
      } else if (
        !committed &&
        !isStaleBasis(error) &&
        (state.stalePresent?.sequence ?? 0) <= intent.sequence
      ) {
        state.stalePresent = undefined;
      }
      try {
        reconcileState(state);
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors);
  };

  const getCommit = (
    sourceTx: IExtendedStorageTransaction,
  ): ReconcileCommit => {
    const commit = commits.get(sourceTx);
    if (!commit) {
      throw new Error("List child change was not registered by begin()");
    }
    return commit;
  };

  const getState = (
    elementKey: string,
    resultCell: Cell<any>,
    options?: {
      created?: boolean;
      release?: () => boolean;
      initialRunGate?: InitialRunGateController;
    },
  ): ElementState | undefined => {
    const elementRun = elementRuns.get(elementKey);
    if (!elementRun || elementRun.resultCell !== resultCell) return undefined;

    const existing = states.get(elementKey);
    if (existing?.elementRun === elementRun && !existing.disposed) {
      return existing;
    }
    if (existing && !existing.disposed) disposeState(existing);

    const state: ElementState = {
      elementKey,
      elementRun,
      release: options?.release,
      initialRunGate: options?.initialRunGate,
      successful: options?.created === true ? undefined : {
        sequence: 0,
        present: true,
        lastIndex: elementRun.lastIndex,
      },
      pending: new Map(),
      disposed: false,
    };
    states.set(elementKey, state);
    return state;
  };

  const track = (
    sourceTx: IExtendedStorageTransaction,
    elementKey: string,
    resultCell: Cell<any>,
    present: boolean,
    lastIndex: number,
    options?: {
      created?: boolean;
      release?: () => boolean;
      initialRunGate?: InitialRunGateController;
    },
  ): void => {
    const commit = getCommit(sourceTx);
    if (commit.ignored) return;
    const state = getState(elementKey, resultCell, options);
    if (!state) return;
    const intent: ElementIntent = {
      sequence: commit.sequence,
      present,
      lastIndex,
    };
    state.pending.set(commit.sequence, intent);
    commit.changes.set(elementKey, { state, intent });
  };

  return {
    begin(sourceTx) {
      if (!active) return false;
      if (commits.has(sourceTx)) {
        throw new Error("List coordinator registered a transaction twice");
      }
      const commit: ReconcileCommit = {
        sequence: nextSequence++,
        changes: new Map(),
        ignored: false,
        settled: false,
      };
      commits.set(sourceTx, commit);
      const coverage = Promise.withResolvers<void>();
      const accepted = sourceTx.addCommitCallback((_committedTx, result) => {
        try {
          settle(sourceTx, !result.error, result.error);
        } finally {
          coverage.resolve();
        }
      });
      if (!accepted) {
        commit.ignored = true;
        return false;
      }
      runtime.storageManager.trackUntilSettled(coverage.promise);
      return true;
    },

    needsPresentSetup(
      elementKey,
      resultCell,
      lastIndex,
      indexAffectsSetup,
    ) {
      const state = states.get(elementKey);
      if (
        state?.elementRun.resultCell !== resultCell || state.disposed ||
        state.successful?.present !== true ||
        (indexAffectsSetup && state.successful.lastIndex !== lastIndex)
      ) {
        return true;
      }
      for (const pending of state.pending.values()) {
        if (
          !pending.present ||
          (indexAffectsSetup && pending.lastIndex !== lastIndex)
        ) {
          return true;
        }
      }
      return false;
    },

    trackPresent(sourceTx, elementKey, resultCell, lastIndex, options) {
      if (!active) return;
      track(
        sourceTx,
        elementKey,
        resultCell,
        true,
        lastIndex,
        options,
      );
    },

    trackRemoval(sourceTx, elementKey, resultCell) {
      if (!active) return;
      const elementRun = elementRuns.get(elementKey);
      if (!elementRun || elementRun.resultCell !== resultCell) return;
      track(
        sourceTx,
        elementKey,
        resultCell,
        false,
        elementRun.lastIndex,
      );
    },

    abort(sourceTx) {
      settle(sourceTx, false);
    },

    cancel() {
      if (!active) return;
      active = false;
      const errors: unknown[] = [];
      for (const state of [...states.values()]) {
        try {
          disposeState(state);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const entry of [...elementRuns.values()]) {
        try {
          runtime.runner.releaseChild(entry.resultCell, undefined);
        } catch (error) {
          errors.push(error);
        }
      }
      elementRuns.clear();
      throwCleanupErrors(errors);
    },
  };
}
