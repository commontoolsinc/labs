import { internSchema } from "@commonfabric/data-model/schema-hash";
import { getLogger } from "@commonfabric/utils/logger";

import type { Pattern } from "../builder/types.ts";
import type { AddCancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import {
  listElementKeys,
  releaseRemovedElements,
} from "./list-element-keys.ts";
import { listElementLink } from "./list-element-link.ts";
import {
  type ElementRun,
  type SetupRecord,
  trackListSetupRollback,
} from "./list-element-rollback.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { seedResultContainerWhenPullSettles } from "./list-result-container-seed.ts";
import { issueResultContainerSetup } from "./list-result-container.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";
import { createResumeRepublisher } from "./resume-republish.ts";
import {
  narrowestCellScope,
  outputSpotFromBinding,
  scopedCell,
} from "./scope-policy.ts";

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

  // Whether the writes that make `result` reachable are owed. The coordinator
  // keeps the container across reconciles, so one that stages those writes and
  // then does not commit leaves it holding a container nothing links to; the
  // next reconcile issues them again. See list-element-rollback.ts.
  const containerSetup: SetupRecord = { needsSetup: false };

  // An element's links back to this coordinator. They are setup writes like the
  // element's pattern run: issued when the element is created, and again when
  // the transaction carrying them did not commit. Without them the element's
  // document names no owning piece, so nothing can start that piece for an
  // event addressed to it.
  const linkElementCell = (cell: Cell<any>): void => {
    setResultCell(cell, parentCell);
    setPatternCell(cell, parentCell.key("pattern"));
  };

  // Identity-based tracking: maps element address key → element run.
  // resultCell holds the predicate boolean for this element.
  const elementRuns = new Map<string, ElementRun>();

  // Cleared when the coordinator is torn down, so the asynchronous resume work
  // below stops writing to a result container nothing owns any more. The same
  // teardown releases the children the coordinator still holds; the ones whose
  // elements left the list were released when they left.
  let active = true;
  addCancel(() => {
    active = false;
    releaseRemovedElements(runtime, elementRuns, new Set());
  });

  // Only the initial (resume) reconcile defers its per-element sub-pattern runs
  // until sync completes; elements from later (post-resume) reconciles are fresh
  // and must not wait. Cleared once a non-empty resume batch is processed.
  let resumeBatchAwaitSync = !!awaitSync;

  // Rebuild the filtered list from the per-element predicate results: keep an
  // input element when its predicate settled truthy, exclude it when the
  // predicate settled a defined falsy value, and treat an undefined predicate as
  // still streaming in. See resume-republish.ts for the convergence machinery.
  // The Action the runner registered for this coordinator (a wrapper around
  // `reconcile`) — the identity the scheduler is keyed by, so the one a
  // re-arm must name.
  let registeredAction: Action | undefined;

  const { awaitingResult, awaitPendingThenRepublish } = createResumeRepublisher(
    {
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
      contribute: (included, inputElement, out) => {
        if (included) out.push(inputElement);
        else if (included === undefined) return "pending";
      },
      rearmReconcile: () => {
        if (registeredAction) {
          runtime.scheduler.invalidateAction(registeredAction);
        }
      },
    },
  );

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
        .then(() =>
          !active ? undefined : runtime.editWithRetry((settleTx) => {
            if (!active || !result) return;
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
            if (error) {
              logger.warn("resume-input", "settling the resumed input failed", {
                error,
              });
            }
          })
        )
        .catch((error) =>
          logger.warn("resume-input", "the resumed input list sync rejected", {
            error,
          })
        ),
    );
  };

  const reconcile: Action = (tx: IExtendedStorageTransaction) => {
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);
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

    // Whether this reconcile issues the container's links: a container it
    // mints needs them, and one whose last issuance did not commit owes them.
    let issueLinks = containerSetup.needsSetup;
    if (!result || result.getAsNormalizedFullLink().scope !== outputScope) {
      const previousResult = result;
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
      // The container outlives this reconcile's transaction; a cell bound to
      // it would pin the settled transaction and its journal for the life of
      // the coordinator. Rebind per use instead.
      result = boundResult.withTx();
      const installedResult = result;
      // Give back only what this reconcile installed. An overlapping reconcile
      // that has already replaced the container owns it, and its bookkeeping
      // matches durable writes of its own.
      rollback.resultReplaced(() => {
        if (result === installedResult) result = previousResult;
      });
      issueLinks = true;
    }
    // A container this coordinator holds is reachable only through the links
    // below, and the reconcile that last issued them may not have committed.
    if (issueLinks) {
      issueResultContainerSetup(
        tx,
        result.withTx(tx),
        parentCell,
        sendResult,
        rollback,
        containerSetup,
      );
    }
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
      // The container's durable value is still streaming in; its arrival
      // re-triggers this reconcile (the read above is journaled). A container
      // that was never persisted has nothing to stream in, so the seed below
      // ends the wait once the pull settles.
      seedResultContainerWhenPullSettles(
        runtime,
        () => active ? result : undefined,
        result.sync(),
        logger,
      );
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
      releaseRemovedElements(runtime, elementRuns, new Set());
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("filter currently only supports arrays");
    }

    // The whole current key set has to exist before any element is touched:
    // it is what says which predicates the list has stopped holding. A
    // released predicate's result never arrives, so releasing it also keeps it
    // out of the hold below.
    const elementKeys = listElementKeys(list);
    releaseRemovedElements(
      runtime,
      elementRuns,
      new Set(elementKeys.values()),
    );

    if (list.length > 0) resumeBatchAwaitSync = false;

    const newArrayValue: any[] = [];
    // Every predicate the resume pass attaches, whatever it currently reads.
    // The values read here are local: a child that ran in this session has
    // written one, and the document behind it may still be catching up. Waiting
    // on the batch is what tells the reconciles that follow which documents
    // cannot yet carry a write.
    const resumeCells: Cell<any>[] = [];
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
        const previousIndex = existing.lastIndex;
        if (
          existing.needsSetup ||
          (argumentUsage.usesIndex && existing.lastIndex !== i)
        ) {
          if (awaitingResult(existing.resultCell)) {
            // This predicate's document has not caught up, so setup written
            // now cannot land: the commit is rejected as stale and the retry
            // reads the same document again. Owe the setup until the wait ends.
            existing.needsSetup = true;
          } else {
            runtime.runner.run(
              tx,
              opPattern,
              createRunInput(list[i], i),
              existing.resultCell,
              {
                doNotUpdateOnPatternChange: true,
                awaitSyncBeforeInitialRun: elementAwaitSync,
              },
            );
            // The whole setup, every time, because issuing it takes the debt
            // for it: an overlapping reconcile that wrote the links and has
            // not settled hands them to this one, and a partial issuance would
            // leave nobody owing them. Links already durable cost a
            // comparison, since a write of the value a leaf already holds does
            // not reach storage.
            linkElementCell(existing.resultCell.withTx(tx));
            rollback.setupIssued(existing);
          }
        }
        existing.lastIndex = i;
        if (previousIndex !== i) rollback.indexChanged(existing, previousIndex);
      } else {
        const boundResultCell = runtime.getCell(
          parentCell.space,
          { filter: result, elementKey },
          undefined,
          tx,
        );
        // The stored cell outlives this reconcile's transaction: it lives in
        // `elementRuns` and in the cancel closure below, both of which last as
        // long as the coordinator. A cell bound to the transaction would pin
        // the settled transaction, its journal, and everything it read.
        const resultCell = boundResultCell.withTx();
        runtime.runner.run(
          tx,
          opPattern,
          createRunInput(list[i], i),
          resultCell,
          {
            doNotUpdateOnPatternChange: true,
            awaitSyncBeforeInitialRun: elementAwaitSync,
          },
        );
        linkElementCell(boundResultCell);

        const entry = { resultCell, lastIndex: i, needsSetup: false };
        elementRuns.set(elementKey, entry);
        rollback.created(elementKey, entry);
      }

      // Read predicate result — creates subscription for reactivity.
      // Truthy/falsy coercion, not strict boolean.
      const childCell = elementRuns.get(elementKey)!.resultCell;
      if (elementAwaitSync) resumeCells.push(childCell);
      const included = childCell.withTx(tx).get();
      if (included) {
        newArrayValue.push(list[i]); // Original element cell reference
      } else if (included === undefined) {
        pendingCells.push(childCell);
      }
    }

    // Wait for the whole resume batch before the aggregate moves. Its
    // documents are the ones still catching up, and republishing from them once
    // they confirm is what keeps a partial view out of the durable container.
    if (resumeCells.length > 0) {
      awaitPendingThenRepublish(resumeCells);
      return;
    }

    // A predicate attached after the resume pass whose result is still
    // streaming in reads undefined and would exclude its element, shrinking
    // the aggregate below the durable value the container already holds.
    // Republishing that shrink is the reload flicker — a populated list blinks
    // to empty and refills. Hold the durable value and wait for the pending
    // predicates to confirm their docs, then republish against the confirmed
    // values. A predicate whose value arrived is included; one confirmed
    // undefined is excluded — so a genuine shrink still converges instead of
    // freezing.
    if (
      priorLen > 0 && newArrayValue.length < priorLen && pendingCells.length > 0
    ) {
      awaitPendingThenRepublish(pendingCells);
      return;
    }
    probeScoped(() => resultWithLog.set(newArrayValue));
  };

  // Child-starting coordinator: never rehydrates clean on resume — the
  // reconcile must run to re-attach the per-element children (which then
  // rehydrate their own persisted state). See
  // docs/specs/scheduler-v2/per-doc-rehydration.md §3.3.
  return {
    action: reconcile,
    resumeMode: "always-run",
    onActionRegistered: (action) => {
      registeredAction = action;
    },
  };
}
