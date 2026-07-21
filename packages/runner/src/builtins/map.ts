import { type Pattern } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    // `processDefaultValue()` treats `asCell` as an opaque cell boundary, so
    // `type: "unknown"` only documents the inner value shape here.
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

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

import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { outputSpotFromBinding } from "./scope-policy.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import {
  cellIdentityKey,
  exposedResultCell,
  scopedCell,
} from "./scope-policy.ts";
import { resolveLink } from "../link-resolution.ts";
import { listElementLink } from "./list-element-link.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isDataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { shouldAwaitResumedListInput } from "./list-resume-state.ts";

const logger = getLogger("runner.map", { enabled: true, level: "warn" });

/**
 * Implementation of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * This supports both legacy map calls and closure-transformed map calls:
 * - Legacy mode (params === undefined): Passes { element, index, array } to pattern
 * - Closure mode (params !== undefined): Passes { element, index, array, params } to pattern
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Elements are tracked by the normalized link address of their cell (via
 * `getAsNormalizedFullLink()`). The `asSchema` traverse with
 * `asCell: ["cell"]` already resolves cell links to target entities, so:
 *
 * - Cell links: `list[i]` resolves to a cell pointing at the target entity.
 *   Its normalized link is stable across position changes, enabling reuse.
 * - Inline values: `list[i]` resolves to a cell pointing at the array position.
 *   Its normalized link includes the positional index, so identity = position.
 *   Shifted inline values get new runs (acceptable trade-off).
 *
 * @param list - A doc containing an array of values to map over.
 * @param op - A pattern to apply to each value.
 * @param params - Optional object containing captured variables from outer scope (closure mode).
 * @returns A doc containing the mapped values.
 */
export function map(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): RawBuiltinReturnType {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // for reuse across position changes. We pass list[i] directly each time, so
  // there's no need to store the element cell separately.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  // Only the initial (resume) reconcile should defer its per-element sub-pattern
  // runs until storage sync completes. This coordinator registers as
  // resumeMode "always-run" with a synced-hold (it never rehydrates clean —
  // see the return below), so its first reconcile runs against synced data;
  // the per-element runs it starts carry the same intent, which is what lets
  // each child rehydrate its own persisted state at registration. Elements
  // added by later (post-resume) reconciles are fresh and must not wait.
  let resumeBatchAwaitSync = !!awaitSync;

  // Hold the durable container while the input list itself confirms. On a resume
  // reconcile the input can be undefined or a transient empty default standing in
  // while the real list streams in; setting [] then would clobber the durable
  // container the resume loaded. Await the resolved input and, once it confirms,
  // clear the container only if the input is genuinely empty — a non-empty input
  // re-triggers the normal reconcile via its journaled read, so it converges
  // either way.
  const awaitInputThenSettle = (inputListCell: Cell<any>): void => {
    runtime.storageManager.trackUntilSettled(
      inputListCell.sync()
        .then(() =>
          runtime.editWithRetry((settleTx) => {
            if (!result) return;
            const raw = inputsCell.key("list").withTx(settleTx).resolveAsCell()
              .withTx(settleTx).getRaw();
            if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
              settleTx.runWithAmbientReadMeta(
                { ...linkResolutionProbe, ...machineryRead },
                () =>
                  result!.asSchema(RESULT_PRESENCE_SCHEMA).withTx(settleTx).set(
                    [],
                  ),
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
    // Captured before the loop consumes it: this reconcile's element runs use
    // the current value; the flag is cleared only once a non-empty resume batch
    // has been processed (below), so a transient empty first reconcile doesn't
    // burn it.
    const elementAwaitSync = resumeBatchAwaitSync;
    const mappedInputs = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);
    const op = mappedInputs.key("op").get();
    const sourceListCell = inputsCell.key("list");
    const listTarget = resolveLink(
      runtime,
      tx,
      sourceListCell.getAsNormalizedFullLink(),
      "writeRedirect",
    );
    const listScope = listTarget.scope;
    // `array` callback arguments should observe the actual list entity, not the
    // alias/boxed reference used to pass that list into the builtin.
    const listCell = sourceListCell.withTx(tx).resolveAsCell();
    // Identity-only list materialization: read the raw slots (journals the
    // list-doc read for reactivity and label flow — membership/order ARE
    // the list's content) and build element cells from the slot links
    // directly. The asCell traversal here used to dereference each slot's
    // target ("arrays dereference one more link"), journaling a content
    // read of every element doc the coordinator never consumes — under
    // flow labels (S16) that joined every element's label into the
    // coordinator's J and smeared it across sibling scaffolding.
    // resolveLink's probes belong to the dereferences it records, so flow
    // derivation treats them as resolution machinery, not followRef
    // observations (observation classes C1); no element value is loaded at
    // all.
    const rawList = listCell.withTx(tx).getRaw() as unknown;
    const listBase = listCell.getAsNormalizedFullLink();
    const list: Cell<any>[] | undefined = rawList === undefined
      ? undefined
      : !Array.isArray(rawList)
      ? rawList as unknown as Cell<any>[] // non-array: handled by the guard below
      : rawList.map((slot, i) => {
        const slotLink = listElementLink(runtime.cfc, listBase, slot, i);
        const resolved = resolveLink(runtime, tx, slotLink, "value");
        return runtime.getCellFromLink(resolved, undefined, tx);
      });
    // .getRaw() because we want the pattern itself and avoid following the
    // aliases in the pattern. The raw value is either a compact
    // `{ $patternRef }` sentinel (resolved to the live canonical pattern by
    // identity) or, on the legacy path, the embedded pattern graph itself.
    const opPattern = resolveOpPattern(runtime, op.getRaw(), "map");
    const argumentUsage = inferListOpArgumentUsage(runtime.cfc, opPattern);

    if (!result || result.getAsNormalizedFullLink().scope !== listScope) {
      const resultSchema = listResultSchema(opPattern.resultSchema);
      // CT-1623: identify the result container by the reserved output spot —
      // the fully-resolved write-redirect target the runner supplies as the
      // `outputBinding`. It is a stable, position-derived, program-independent
      // identity, unlike the serialized `op` / inputs, both of which drag in the
      // session-varying `program` and force the container id (and every per-row
      // id derived from it) to churn across reloads. A `map` node always writes
      // through a write redirect, so the absence of an output spot is a bug.
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) {
        throw new Error(
          "map: result container requires a write-redirect output binding",
        );
      }
      const baseResult = runtime.getCell<any[]>(
        parentCell.space,
        { map: parentCell.entityId, outputSpot },
        resultSchema,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, listScope);
      setResultCell(result, parentCell);
      // Link the new result cells to the pattern cell too
      setPatternCell(result, parentCell.key("pattern"));
      sendResult(tx, result);
    }
    // The coordinator's view of the result container is links-only
    // (RESULT_PRESENCE_SCHEMA): get() probes presence and set() diffs
    // prior slots as links, never materializing element contents. A
    // content-schema view here journals value reads of every element
    // result on each reconcile — under flow labels (S16) that smears
    // every element's taint into the coordinator's per-tx join.
    const resultWithLog = result.asSchema(RESULT_PRESENCE_SCHEMA)
      .withTx(tx);

    if (isDataUnavailable(rawList)) {
      resultWithLog.setRawUntyped(rawList, true);
      for (const entry of elementRuns.values()) {
        runtime.runner.stop(entry.resultCell);
      }
      elementRuns.clear();
      return;
    }

    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: listCell } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    // If the result's value is undefined, set it to the empty array.
    // Container reads run under the link-resolution-probe scope: the
    // presence probe and set() diffing materialize prior slot targets for
    // identity comparison only — the coordinator never consumes element
    // content, and the written links carry their per-slot labels via the
    // link-write machinery. Without the scope, the asCell slot dereference
    // journals a content read of every prior element result, feeding the
    // coordinator's own output taint back into its next reconcile's J and
    // smearing it onto fresh elements' scaffolding (S16 pointwise).
    // machineryRead rides along (template-population §6): the same
    // scaffolding reads must not consume `*`-path membership templates on
    // plumbing containers now that the generic mint route is on (SC-8).
    const probeScoped = <T>(fn: () => T): T =>
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        fn,
      );
    const rawResult = probeScoped(() => result!.getRaw());
    // Resume against confirmed state, not the not-yet-loaded value: on the
    // resume reconcile an undefined container is its durable value still
    // streaming in (a map that has run persisted at least []). Reconciling now
    // would write a stale-basis result that conflicts on commit and re-runs
    // against the same absent value until it happens to sync — the reload
    // commit storm. Pull the container and defer; its arrival re-triggers this
    // reconcile, which then no-ops against the durable value.
    if (
      elementAwaitSync &&
      !isDataUnavailable(rawResult) &&
      probeScoped(() => resultWithLog.get()) === undefined
    ) {
      const pending = result.sync();
      // The container's durable value is still streaming in; its arrival
      // re-triggers this reconcile (the probe read above is journaled). If the
      // container was never persisted — so nothing will ever stream in to
      // re-trigger — seed [] once the pull settles, so the coordinator is not
      // left wedged waiting for a value that will never arrive.
      const seedIfStillAbsent = () =>
        runtime.editWithRetry((seedTx) => {
          const container = result!.withTx(seedTx);
          if (container.getRaw() === undefined) container.set([]);
        }).then(({ error }) => {
          if (error) {
            logger.warn(
              "resume-seed",
              "seeding the empty result container failed",
              { error },
            );
          }
        });
      // Run on either outcome (resolve or reject); the seed recovers from the
      // pull's own rejection, so log it rather than dropping it silently.
      pending.finally(seedIfStillAbsent).catch((error) => {
        logger.warn("resume-pull", "resume container pull rejected", {
          error,
        });
      });
      return;
    }
    // Resume preservation: on a resume reconcile the input list itself may not be
    // confirmed yet — undefined, or a transient empty default while the real list
    // streams in. Setting [] now would clobber the durable container the resume
    // loaded (map's output is link-shaped, so its slots survive a pending element,
    // but a pending input would still blank the whole container). Hold it and
    // await the input; a non-empty input then re-triggers this reconcile via its
    // journaled read, and a confirmed empty input clears the container. Outside
    // resume the flag is clear, so a list set undefined at runtime still runs the
    // cleanup below.
    const priorSlots = probeScoped(() => resultWithLog.get());
    const priorLen = Array.isArray(priorSlots) ? priorSlots.length : 0;
    if (
      shouldAwaitResumedListInput(
        elementAwaitSync,
        rawResult,
        list,
        priorLen,
      )
    ) {
      awaitInputThenSettle(listCell);
      return;
    }

    // A fresh (non-resume) reconcile has no container yet; seed [] so the first
    // render has a value. On resume this is unreachable — the defer guard above
    // either holds for the still-loading container or sees the durable value, so
    // priorSlots is never undefined here.
    if (priorSlots === undefined) {
      probeScoped(() => resultWithLog.set([]));
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      probeScoped(() => resultWithLog.set([]));
      for (const entry of elementRuns.values()) {
        runtime.runner.stop(entry.resultCell);
      }
      elementRuns.clear();
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    // The resume batch has now been observed; later reconciles are post-resume.
    if (list.length > 0) resumeBatchAwaitSync = false;

    const keyCounts = new Map<string, number>();
    const newArrayValue = new Array<any>(list.length);
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create pattern runs for them
      if (!(i in list)) continue;

      const { dedupKey, linkKey } = cellIdentityKey(list[i]);
      const occurrence = keyCounts.get(dedupKey) ?? 0;
      keyCounts.set(dedupKey, occurrence + 1);
      const elementKey = JSON.stringify([...linkKey, occurrence]);

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (argumentUsage.usesIndex && existing.lastIndex !== i) {
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
        }
        existing.lastIndex = i;
        newArrayValue[i] = exposedResultCell(runtime, tx, existing.resultCell);
      } else {
        const resultCell = runtime.getCell(
          parentCell.space,
          { map: result, elementKey },
          undefined,
          tx,
        );
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
        // Link these individual cells to the top cell
        setResultCell(resultCell, parentCell);
        // Link the new result cells to the pattern cell too
        setPatternCell(resultCell, parentCell.key("pattern"));
        addCancel(() => runtime.runner.stop(resultCell));
        elementRuns.set(elementKey, { resultCell, lastIndex: i });
        newArrayValue[i] = exposedResultCell(runtime, tx, resultCell);
      }
    }
    probeScoped(() => resultWithLog.set(newArrayValue));

    // NOTE: We leave prior results in elementRuns for now, so they reuse
    // prior runs when items reappear. This means elementRuns grows
    // unboundedly when elements are removed — the runner is stopped via
    // addCancel when the parent is disposed, but the Map entries (and their
    // resultCell references) are not pruned. TODO: Consider pruning entries
    // not present in the current list if this becomes a problem for
    // long-lived maps with high element churn.
  };

  // Child-starting coordinator: never rehydrates clean on resume — the
  // reconcile must run to re-attach the per-element children (which then
  // rehydrate their own persisted state). See
  // docs/specs/scheduler-v2/per-doc-rehydration.md §3.3.
  return { action: reconcile, resumeMode: "always-run" };
}
