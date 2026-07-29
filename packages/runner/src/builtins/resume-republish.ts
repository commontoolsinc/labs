import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { Logger } from "@commonfabric/utils/logger";
import type { JSONSchema } from "../builder/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Action } from "../scheduler/types.ts";
import { cellIdentityKey } from "./scope-policy.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";

type ElementRuns = Map<
  string,
  { resultCell: Cell<any>; lastIndex: number }
>;

export interface RegisteredActionRearm {
  rearm(): void;
  onActionRegistered(action: Action): void;
}

/** Store the scheduler's registered action and use it for later reruns. */
export function createRegisteredActionRearm(
  runtime: Runtime,
): RegisteredActionRearm {
  let registeredAction: Action | undefined;
  return {
    rearm() {
      if (registeredAction) {
        runtime.scheduler.invalidateAction(registeredAction);
      }
    },
    onActionRegistered(action) {
      registeredAction = action;
    },
  };
}

/**
 * Decide what one element contributes to the rebuilt aggregate. `value` is the
 * element's per-element result (a predicate boolean for filter, a result value
 * or array for flatMap); `inputElement` is the corresponding input list entry.
 * Append the contribution to `out`, or return "pending" if the element's result
 * has not arrived yet. A present-but-undefined value that the builtin treats as
 * a settled exclusion contributes nothing and is not pending.
 */
export type ElementContribution = (
  value: unknown,
  inputElement: unknown,
  out: any[],
) => "pending" | void;

export interface ResumeRepublisher {
  /**
   * Record reads of current element-result cells whose sync has not settled.
   * Returns true when the caller should leave the aggregate unchanged.
   */
  readPendingSyncs(
    tx: IExtendedStorageTransaction,
    currentElementKeys: ReadonlySet<string>,
  ): boolean;

  /**
   * Hold the durable aggregate while the given still-pending element result
   * cells confirm their docs, then rebuild and write it. The entry point; the
   * republish it schedules re-defers any straggler and calls back in.
   */
  awaitPendingThenRepublish(cells: Cell<any>[], awaited?: Set<string>): void;
}

export interface ResumeRepublisherOptions {
  runtime: Runtime;
  logger: Logger;
  /**
   * False once the coordinator is torn down. A republish outstanding at that
   * moment has a container nothing owns any more, so it is dropped rather than
   * written.
   */
  isActive: () => boolean;
  /**
   * The result container is bound after the builtin's setup, so it is read
   * lazily on each republish rather than captured once.
   */
  getResult: () => Cell<any[]> | undefined;
  inputsCell: Cell<any>;
  inputSchema: JSONSchema;
  resultSchema: JSONSchema;
  elementRuns: ElementRuns;
  contribute: ElementContribution;
  /** Re-runs the coordinator after a republish finds an element with no run. */
  rearmReconcile: () => void;
  /** The aggregate's noun for logs, e.g. "filtered list" / "flatMap result". */
  aggregateNoun: string;
  /** The per-element noun for logs, e.g. "predicate" / "result". */
  elementNoun: string;
}

/**
 * Shared resume-preservation machinery for the list builtins that rebuild an
 * aggregate from per-element results (filter, flatMap). map does not use it: its
 * output is link-shaped and never holds element values to reconcile.
 *
 * On a resume reconcile the durable aggregate is held while the per-element
 * results stream in. Once their docs confirm, the aggregate is rebuilt from the
 * settled results and written. The only per-builtin variation is how each
 * element maps to its contribution, supplied as `contribute`; everything else —
 * the element-identity keying, the straggler re-defer, and the convergence
 * bookkeeping — is the same.
 *
 * `awaited` holds the ids of result cells whose sync has already resolved in
 * this republish chain. An undefined result in that set has settled (the builtin
 * excludes or skips it — convergence), while an undefined result not in it is
 * still streaming in, for example a child mid-revert that read a value at defer
 * time and so was never in the pending set. Rather than write a partial shrink,
 * those stragglers are returned to be re-awaited before republishing.
 */
export function createResumeRepublisher(
  opts: ResumeRepublisherOptions,
): ResumeRepublisher {
  const {
    runtime,
    logger,
    isActive,
    getResult,
    inputsCell,
    inputSchema,
    resultSchema,
    elementRuns,
    contribute,
    rearmReconcile,
    aggregateNoun,
    elementNoun,
  } = opts;
  const pendingSyncs = new Map<
    string,
    { cell: Cell<any>; promise: Promise<Cell<any>> }
  >();

  const pendingSync = (cell: Cell<any>): Promise<Cell<any>> => {
    const id = cell.getAsNormalizedFullLink().id;
    const existing = pendingSyncs.get(id);
    if (existing) return existing.promise;

    const promise = cell.sync().finally(() => {
      if (pendingSyncs.get(id)?.promise === promise) pendingSyncs.delete(id);
    });
    pendingSyncs.set(id, { cell, promise });
    return promise;
  };

  const readPendingSyncs = (
    tx: IExtendedStorageTransaction,
    currentElementKeys: ReadonlySet<string>,
  ): boolean => {
    const currentIds = new Set<string>(
      [...currentElementKeys]
        .map((elementKey) => elementRuns.get(elementKey)?.resultCell)
        .filter((cell): cell is Cell<any> => cell !== undefined)
        .map((cell) => cell.getAsNormalizedFullLink().id),
    );
    let pending = false;
    for (const [id, { cell }] of pendingSyncs) {
      if (!currentIds.has(id)) continue;
      cell.withTx(tx).get();
      pending = true;
    }
    return pending;
  };

  const republishFromConfirmed = (awaited: Set<string>): Promise<void> => {
    if (!isActive()) return Promise.resolve();
    return runtime.editWithRetry((tx): {
      pending: Cell<any>[];
      missingRun: boolean;
    } => {
      if (!isActive()) return { pending: [], missingRun: false };
      const result = getResult();
      if (!result) return { pending: [], missingRun: false };
      const inputs = inputsCell.asSchema(inputSchema).withTx(tx).get() as {
        list?: unknown;
      };
      const list = inputs?.list;
      if (!Array.isArray(list)) return { pending: [], missingRun: false };
      const keyCounts = new Map<string, number>();
      const out: any[] = [];
      const stillPending: Cell<any>[] = [];
      let missingRun = false;
      for (let i = 0; i < list.length; i++) {
        if (!(i in list)) continue;
        const { dedupKey, linkKey } = cellIdentityKey(list[i]);
        const occurrence = keyCounts.get(dedupKey) ?? 0;
        keyCounts.set(dedupKey, occurrence + 1);
        const elementKey = JSON.stringify([...linkKey, occurrence]);
        const entry = elementRuns.get(elementKey);
        if (!entry) {
          missingRun = true;
          continue;
        }
        const value = entry.resultCell.withTx(tx).get();
        if (
          contribute(value, list[i], out) === "pending" &&
          !awaited.has(entry.resultCell.getAsNormalizedFullLink().id)
        ) {
          stillPending.push(entry.resultCell);
        }
      }
      if (stillPending.length > 0) {
        return { pending: stillPending, missingRun };
      }
      // The element reads above are real content reads (the aggregate genuinely
      // depends on them, so they taint J). The container write only diffs prior
      // slots for identity, so it runs under the link-resolution probe (S16) to
      // avoid re-journaling prior element content — matching map/filter/flatMap.
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        () => result.asSchema(resultSchema).withTx(tx).set(out),
      );
      return { pending: [], missingRun };
    }).then(({ ok, error }) => {
      if (!isActive()) return;
      if (error) {
        logger.warn(
          "resume-republish",
          `republishing the ${aggregateNoun} failed`,
          { error },
        );
        return;
      }
      if (ok && ok.pending.length > 0) {
        awaitPendingThenRepublish(ok.pending, awaited);
        return;
      }
      if (ok?.missingRun) {
        rearmReconcile();
      }
    });
  };

  // Hold the durable aggregate while the still-pending elements confirm their
  // docs, then republish. Each element's sync resolves whether its value arrives
  // or its doc is confirmed absent, so the republish runs against settled state.
  // Using sync as an async confirmation, not a read-time guess, is the
  // load-bearing distinction here. `awaited` accumulates the confirmed ids across
  // a chain of re-awaits, so a straggler found at republish time is awaited too
  // and a settled-undefined element is honored once rather than awaited forever.
  const awaitPendingThenRepublish = (
    cells: Cell<any>[],
    awaited: Set<string> = new Set<string>(),
  ): void => {
    if (!isActive()) return;
    for (const c of cells) awaited.add(c.getAsNormalizedFullLink().id);
    runtime.storageManager.trackUntilSettled(
      Promise.all(cells.map(pendingSync))
        .then(() => isActive() ? republishFromConfirmed(awaited) : undefined)
        .catch((error) => {
          if (isActive()) {
            logger.warn(
              "resume-republish",
              `a pending ${elementNoun} sync rejected`,
              { error },
            );
          }
        }),
    );
  };

  return { readPendingSyncs, awaitPendingThenRepublish };
}
