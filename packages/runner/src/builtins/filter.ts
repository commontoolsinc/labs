import type { Pattern } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

// Presence probe for the result container: slots resolve as cells, so the
// coordinator can ask "is the container initialized?" without materializing
// element contents. A content-schema get() here would journal real value
// reads of every element result — under flow labels (S16) that smears every
// element's taint into the coordinator's per-tx join and from there onto
// sibling scaffolding (the read-own-output feedback).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

const FILTER_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

import type { Cell } from "../cell.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import {
  narrowestCellScope,
  outputSpotFromBinding,
  scopedCell,
} from "./scope-policy.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";
import { listElementKeys } from "./list-element-keys.ts";
import {
  createRegisteredActionRearm,
  createResumeRepublisher,
} from "./resume-republish.ts";
import { createElementRunCommitGuard } from "./element-run-commit-guard.ts";
import { isRetryImmediately } from "../scheduler/retry-immediately.ts";
import { createInitialRunGate } from "../scheduler/initial-run-gate.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import { resolveLink } from "../link-resolution.ts";
import { listElementLink } from "./list-element-link.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("runner.filter", { enabled: true, level: "warn" });

/**
 * Implementation of built-in filter module. Like map, this is called once at
 * setup and manages its own actions for the scheduler.
 *
 * Runs a predicate pattern per element. The output array contains cell
 * references to the original input elements where the predicate is truthy.
 * Output is always dense (no holes), even when the input is sparse.
 *
 * Identity tracking and reconciliation are identical to map — see map.ts for
 * the full explanation of how getAsNormalizedFullLink() provides stable
 * identity for cell links and positional identity for inline values.
 *
 * Two-pass convergence: when a new element appears, its predicate pattern
 * hasn't run yet, so the predicate cell is undefined and the element is
 * excluded. The predicate then runs, updating its cell, which re-triggers
 * this action. On the second pass the element is correctly included or
 * excluded.
 */
export function filter(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → element run.
  // resultCell holds the predicate boolean for this element.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();
  let active = true;
  const childCommitGuard = createElementRunCommitGuard({
    runtime,
    elementRuns,
  });
  addCancel(() => {
    active = false;
    childCommitGuard.cancel();
  });

  // Only the initial (resume) reconcile defers its per-element sub-pattern runs
  // until sync completes; elements from later (post-resume) reconciles are fresh
  // and must not wait. Cleared once a non-empty resume batch is processed.
  let resumeBatchAwaitSync = !!awaitSync;

  // Rebuild the filtered list from the per-element predicate results: keep an
  // input element when its predicate settled truthy, exclude it when the
  // predicate settled a defined falsy value, and treat an undefined predicate as
  // still streaming in. See resume-republish.ts for the convergence machinery.
  const actionRearm = createRegisteredActionRearm(runtime);
  const { readPendingSyncs, awaitPendingThenRepublish } =
    createResumeRepublisher({
      runtime,
      logger,
      isActive: () => active,
      getResult: () => result,
      inputsCell,
      inputSchema: FILTER_INPUT_SCHEMA,
      resultSchema: RESULT_PRESENCE_SCHEMA,
      elementRuns,
      aggregateNoun: "filtered list",
      elementNoun: "predicate",
      rearmReconcile: actionRearm.rearm,
      contribute: (included, inputElement, out) => {
        if (included) out.push(inputElement);
        else if (included === undefined) return "pending";
      },
    });

  // Hold the durable list while the input list itself confirms. On a resume
  // reconcile the input can be undefined or a transient empty default standing in
  // while the real list streams in; setting [] then would clobber the durable
  // aggregate. Await the resolved input and, once it confirms, clear the result
  // only if the input is genuinely empty — a non-empty input re-triggers the
  // normal reconcile via its journaled read, so it converges either way.
  const awaitInputThenSettle = (
    inputListCell: Cell<any>,
  ): void => {
    runtime.storageManager.trackUntilSettled(
      inputListCell.sync()
        .then(() => {
          if (!active) return;
          return runtime.editWithRetry((settleTx) => {
            if (!active) return;
            if (!result) return;
            const { list } = inputsCell.asSchema(FILTER_INPUT_SCHEMA)
              .withTx(settleTx).get();
            if (
              list === undefined || (Array.isArray(list) && list.length === 0)
            ) {
              settleTx.runWithAmbientReadMeta(
                { ...linkResolutionProbe, ...machineryRead },
                () =>
                  result!.asSchema(RESULT_PRESENCE_SCHEMA).withTx(settleTx)
                    .set([]),
              );
            }
          }).then(({ error }) => {
            if (!active) return;
            if (error) {
              logger.warn("resume-input", "settling the resumed input failed", {
                error,
              });
            }
          });
        })
        .catch((error) => {
          if (active) {
            logger.warn(
              "resume-input",
              "the resumed input list sync rejected",
              { error },
            );
          }
        }),
    );
  };

  const reconcileImpl = (
    tx: IExtendedStorageTransaction,
    ownsChildChanges: boolean,
  ) => {
    const elementAwaitSync = resumeBatchAwaitSync;
    // Identity-only list materialization (mirrors map.ts:163-188): read `op`
    // through the schema, but build element cells from the raw slot links
    // WITHOUT dereferencing element content. The previous
    // `asSchema(FILTER_INPUT_SCHEMA).get()` walked the array as asCell items,
    // and arrays "dereference one more link" (traverse.ts) — an ordinary content
    // read of every element doc, joining each element's whole-doc label into the
    // coordinator's per-tx J and smearing MEMBER content onto the result
    // container's STRUCTURE label even when membership does not depend on element
    // content (spec §8.5.6.1, SC-8). Membership taint now rides the
    // predicate-result reads below + the structure re-stamp (see
    // recordCfcStructureContainer). resolveLink's probe reads are flow-excluded.
    const op = inputsCell.asSchema(FILTER_INPUT_SCHEMA).withTx(tx).key("op")
      .get();
    const sourceListCell = inputsCell.key("list");
    const listCell = sourceListCell.withTx(tx).resolveAsCell();
    const rawList = listCell.withTx(tx).getRaw() as unknown;
    const listBase = listCell.getAsNormalizedFullLink();
    const list: Cell<any>[] | undefined = rawList === undefined
      ? undefined
      : !Array.isArray(rawList)
      ? rawList as unknown as Cell<any>[] // non-array: handled by the guard below
      : rawList.map((slot, i) => {
        const slotLink = listElementLink(listBase, slot, i);
        const resolved = resolveLink(runtime, tx, slotLink, "value");
        return runtime.getCellFromLink(resolved, undefined, tx);
      });

    const opPattern = resolveOpPattern(runtime, op.getRaw(), "filter");
    const argumentUsage = inferListOpArgumentUsage(opPattern);
    const outputScope = narrowestCellScope(runtime, tx, [
      inputsCell.key("list"),
      ...(Array.isArray(list) && argumentUsage.usesElement ? list : []),
      argumentUsage.usesArray ? inputsCell.key("list") : undefined,
      argumentUsage.usesParams ? inputsCell.key("params") : undefined,
    ]);

    if (!result || result.getAsNormalizedFullLink().scope !== outputScope) {
      const resultSchema = listResultSchema();
      // CT-1623: identify the result container by the reserved output spot
      // (stable, program-independent). See map.ts for rationale.
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) {
        throw new Error(
          "filter: result container requires a write-redirect output binding",
        );
      }
      const baseResult = runtime.getCell<any[]>(
        parentCell.space,
        { filter: parentCell.entityId, outputSpot },
        resultSchema,
        tx,
      );
      const boundResult = scopedCell(runtime, tx, baseResult, outputScope);
      // The container outlives this reconcile's transaction. Keep only an
      // unbound cell in coordinator state.
      result = boundResult.withTx();
    }
    // Each reconcile owns a complete publication. This keeps an overlapping
    // commit independent from an earlier transaction that first chose the
    // same deterministic container and later failed.
    const resultForTx = result.withTx(tx);
    setResultCell(resultForTx, parentCell);
    setPatternCell(resultForTx, parentCell.key("pattern"));
    sendResult(tx, resultForTx);
    // The coordinator's view of the result container is links-only
    // (RESULT_PRESENCE_SCHEMA): get() probes presence and set() diffs
    // prior slots as links, never materializing element contents. A
    // content-schema view here journals value reads of every element
    // result on each reconcile — under flow labels (S16) that smears
    // every element's taint into the coordinator's per-tx join.
    const resultWithLog = result.asSchema(RESULT_PRESENCE_SCHEMA)
      .withTx(tx);
    // (S16) Declare the result container so prepare re-derives its `structure`
    // label (membership/order, §8.5.6.1) from this tx's J — the selection
    // criteria the coordinator read (predicate results) — EVERY reconcile,
    // decoupled from value writes. The membership taint settles on a later pass
    // than the container's root value write, and incremental changes are
    // slot/no-op writes that never re-stamp the root, so the taint would
    // otherwise never land (the dual of the input-read over-taint this fix
    // removes). Idempotent per reconcile; map deliberately does NOT declare.
    tx.recordCfcStructureContainer(result.getAsNormalizedFullLink());
    // Container reads/writes run under the link-resolution-probe scope (S16):
    // the presence probe and set() diffing materialize prior slots for identity
    // comparison only — per-slot labels ride the link-write machinery, not these
    // reads. See map.ts. Without it the asCell slot dereference journals a
    // content read of every prior element, smearing element taint into the
    // coordinator's per-tx join. The predicate read below stays unprobed: filter
    // membership genuinely depends on it (D4: "predicate results it read carry").
    // machineryRead rides along (template-population §6, SC-8): scaffolding
    // must not consume `*`-path membership templates on plumbing containers.
    const probeScoped = <T>(fn: () => T): T =>
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        fn,
      );
    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: inputsCell.key("list") } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });
    const runElement = (
      element: Cell<any>,
      index: number,
      resultCell: Cell<any>,
    ) =>
      runtime.runner.run(
        tx,
        opPattern,
        createRunInput(element, index),
        resultCell,
        {
          doNotUpdateOnPatternChange: true,
          awaitSyncBeforeInitialRun: elementAwaitSync,
        },
      );

    // Resume against confirmed state, not the not-yet-loaded value: on the
    // resume reconcile an undefined container is its durable value still
    // streaming in (a filter that has run persisted at least []). Reconciling
    // now would write a stale-basis result that conflicts on commit and re-runs
    // against the same absent value until it happens to sync. Pull the
    // container and defer; its arrival re-triggers this reconcile, which then
    // no-ops against the durable value.
    if (
      elementAwaitSync &&
      probeScoped(() => resultWithLog.get()) === undefined
    ) {
      const pending = result.sync();
      // The container's durable value is still streaming in; its arrival
      // re-triggers this reconcile (the read above is journaled). If the
      // container was never persisted — so nothing will ever stream in to
      // re-trigger — seed [] once the pull settles, so the coordinator is not
      // left wedged waiting for a value that never arrives.
      const seedIfStillAbsent = () => {
        if (!active) return Promise.resolve();
        return runtime.editWithRetry((seedTx) => {
          if (!active) return;
          const container = result!.withTx(seedTx);
          if (container.getRaw() === undefined) container.set([]);
        }).then(({ error }) => {
          if (!active) return;
          if (error) {
            logger.warn(
              "resume-seed",
              "seeding the empty result container failed",
              { error },
            );
          }
        });
      };
      // Run on either outcome (resolve or reject); the seed recovers from the
      // pull's own rejection, so log it rather than dropping it silently.
      pending.finally(seedIfStillAbsent).catch((error) => {
        logger.warn("resume-pull", "resume container pull rejected", {
          error,
        });
      });
      return;
    }
    // The durable aggregate currently in the container, read links-only
    // (presence schema), so this is a length comparison rather than a content
    // read of every element.
    const priorSlots = probeScoped(() => resultWithLog.get());
    const priorLen = Array.isArray(priorSlots) ? priorSlots.length : 0;

    // Resume preservation: on a resume reconcile the input list itself may not be
    // confirmed yet — undefined, or a transient empty default while the real list
    // streams in. Setting [] now would clobber the durable aggregate the
    // container already holds. Hold it and await the input; a non-empty input
    // then re-triggers this reconcile via its journaled read, and a confirmed
    // empty input clears the result. Outside resume the flag is clear, so a list
    // set undefined at runtime still runs the cleanup below.
    if (
      elementAwaitSync && priorLen > 0 &&
      (list === undefined || (Array.isArray(list) && list.length === 0))
    ) {
      awaitInputThenSettle(inputsCell.key("list").withTx(tx).resolveAsCell());
      return;
    }

    // A fresh (non-resume) reconcile has no container yet; seed [] so the first
    // render has a value. On resume this is unreachable — the defer guard above
    // either holds for the still-loading container or sees the durable value, so
    // priorSlots is never undefined here.
    if (priorSlots === undefined) {
      probeScoped(() => resultWithLog.set([]));
    }
    if (list === undefined) {
      probeScoped(() => resultWithLog.set([]));
      for (const [elementKey, entry] of elementRuns) {
        childCommitGuard.trackRemoval(tx, elementKey, entry.resultCell);
      }
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("filter currently only supports arrays");
    }

    const elementKeys = listElementKeys(list);
    const currentElementKeys = new Set(elementKeys.values());
    for (const [elementKey, entry] of elementRuns) {
      if (currentElementKeys.has(elementKey)) continue;
      childCommitGuard.trackRemoval(tx, elementKey, entry.resultCell);
    }

    // Hold aggregate and present-child setup while the resume pass confirms
    // current element results. These reads keep the coordinator subscribed to
    // the pending documents.
    if (readPendingSyncs(tx, currentElementKeys)) return;

    if (list.length > 0) resumeBatchAwaitSync = false;

    const newArrayValue: any[] = [];
    const resumeSyncCells: Cell<any>[] = [];
    // Collected when an element is excluded only because its predicate result is
    // still streaming in (reads undefined). Their docs are awaited below so the
    // list can be republished once they confirm — distinct from a predicate that
    // has settled falsy, which reads false and is excluded immediately.
    const pendingCells: Cell<any>[] = [];
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create predicate runs for them
      if (!(i in list)) continue;

      const elementKey = elementKeys.get(i)!;

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (
          ownsChildChanges && childCommitGuard.needsPresentSetup(
            elementKey,
            existing.resultCell,
            i,
            argumentUsage.usesIndex,
          )
        ) {
          runElement(list[i], i, existing.resultCell);
        }
        childCommitGuard.trackPresent(
          tx,
          elementKey,
          existing.resultCell,
          i,
        );
      } else {
        if (!ownsChildChanges) continue;
        const boundResultCell = runtime.getCell(
          parentCell.space,
          { filter: result, elementKey },
          undefined,
          tx,
        );
        // The stored cell outlives this reconcile's transaction. Keep only an
        // unbound cell in the coordinator and its cleanup closure.
        const resultCell = boundResultCell.withTx();
        const initialRunGate = createInitialRunGate();
        const childRun = runtime.runner.runChild(
          tx,
          opPattern,
          createRunInput(list[i], i),
          resultCell,
          {
            doNotUpdateOnPatternChange: true,
            awaitSyncBeforeInitialRun: elementAwaitSync,
            initialRunGate: initialRunGate.gate,
          },
        );
        // Link these individual cells to the top cell
        setResultCell(boundResultCell, parentCell);
        // Link the new result cells to the pattern cell too
        setPatternCell(boundResultCell, parentCell.key("pattern"));

        elementRuns.set(elementKey, { resultCell, lastIndex: i });

        childCommitGuard.trackPresent(tx, elementKey, resultCell, i, {
          created: true,
          release: childRun.release,
          initialRunGate,
        });
      }

      // Read predicate result — creates subscription for reactivity.
      // Truthy/falsy coercion, not strict boolean.
      const childCell = elementRuns.get(elementKey)!.resultCell;
      if (elementAwaitSync) resumeSyncCells.push(childCell);
      const included = childCell.withTx(tx).get();
      if (included) {
        newArrayValue.push(list[i]); // Original element cell reference
      } else if (included === undefined) {
        pendingCells.push(childCell);
      }
    }

    // Confirm every predicate document attached by the resume pass before a
    // later reconcile changes child setup or the aggregate.
    if (resumeSyncCells.length > 0) {
      awaitPendingThenRepublish(resumeSyncCells);
      return;
    }

    // Resume preservation: a predicate whose result is still streaming in reads
    // undefined and would exclude its element, shrinking the aggregate below the
    // durable value the container already holds. Republishing that shrink is the
    // reload flicker — a populated list blinks to empty and refills. Hold the
    // durable value and wait for the pending predicates to confirm their docs,
    // then republish against the confirmed values. A predicate whose value
    // arrived is included; one confirmed undefined is excluded — so a genuine
    // shrink still converges instead of freezing.
    if (
      priorLen > 0 && newArrayValue.length < priorLen && pendingCells.length > 0
    ) {
      awaitPendingThenRepublish(pendingCells);
      return;
    }
    probeScoped(() => resultWithLog.set(newArrayValue));
  };

  const reconcile: Action = (tx: IExtendedStorageTransaction) => {
    if (!active) return;
    const ownsChildChanges = childCommitGuard.begin(tx);
    try {
      return reconcileImpl(tx, ownsChildChanges);
    } catch (error) {
      // RetryImmediately aborts without committing, so its commit callbacks do
      // not run. Remove this attempt before the scheduler starts its retry.
      if (isRetryImmediately(error)) childCommitGuard.abort(tx);
      throw error;
    }
  };
  // Child-starting coordinator: never rehydrates clean on resume — the
  // reconcile must run to re-attach the per-element children (which then
  // rehydrate their own persisted state). See
  // docs/specs/scheduler-v2/per-doc-rehydration.md §3.3.
  return {
    action: reconcile,
    resumeMode: "always-run",
    onActionRegistered: actionRearm.onActionRegistered,
  };
}
