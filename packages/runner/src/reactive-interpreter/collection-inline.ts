/**
 * INLINE COLLECTION coordinator (W5) — replaces an eligible `map` boundary's
 * legacy coordinator with a synthetic raw node that evaluates each element's
 * ROG via `evalRog` instead of instantiating a per-element CHILD PATTERN.
 *
 * Per element, legacy pays ~3 docs + ~4 scheduler nodes (child result / arg /
 * process docs + child nodes). Inline pays ONE per-element result doc + one
 * scheduled effect (v1 D-W3-PRECISION Option A) — read-isolated per element
 * (its own tx reads only slot i → structurally pointwise CFC), with the
 * consolidated RAW element write (v1 §4.8: `setRawUntyped(
 * fabricFromNativeValue(convertCellsToLinks(out)))`) so a rendered VNode
 * subtree stays ONE doc instead of fragmenting per node.
 *
 * The element ROG comes from the LIVE element factory captured at pattern
 * construction (BuiltRog.collectionElements) — the serialization boundary
 * that starves the per-element child re-dispatch (`no_rog`) never applies.
 *
 * Ported from #4298's collection-interpreter.ts with v2 adaptations: live
 * BuiltRog instead of raw-graph extraction + implRef resolution; whole-child
 * evalRog (the element result is the child ROG's own result expression);
 * legacy-parity container identity (`{map: parentCell.entityId, outputSpot}`
 * + list scope — a flag flip mid-life reuses the same container); the
 * resume/await-sync container guard ported from legacy map.ts.
 */

import { internSchema } from "@commonfabric/data-model/schema-hash";
import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { listResultSchema } from "../builtins/list-result-schema.ts";
import { convertCellsToLinks } from "../cell.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import {
  exposedResultCell,
  outputSpotFromBinding,
  scopedCell,
} from "../builtins/scope-policy.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import { linkResolutionProbe } from "../storage/reactivity-log.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel, Cancel } from "../cancel.ts";
import type { Cell, JSONSchema, Pattern } from "../builder/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { resolveOpPattern } from "../builtins/op-pattern-ref.ts";
import { map as legacyMapBuiltin } from "../builtins/map.ts";
import type { BuiltRog } from "./from-builder.ts";
import { evalRog } from "./interpret.ts";

const RI2_DEBUG = (() => {
  try {
    return Deno.env.get("RI2_DEBUG") === "1";
  } catch {
    return false;
  }
})();

// Links-only container view: slots stay cell links so container writes are
// PURE LINK STRUCTURE (structure stamps only — never a smearing derived one).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

export interface InlineCollectionEligibility {
  /** The live element pattern factory (BuiltRog.collectionElements). */
  elementFactory: unknown;
  /** The element's BuiltRog (complete + fully pure — dispatch-checked). */
  elementBuilt: BuiltRog;
}

/** Which child-argument fields the element ROG ACTUALLY reads (the ROG is
 * ground truth — legacy's schema-based inference resolves any path through
 * an open schema and over-reports). `array` hands the child the whole list —
 * incompatible with per-element read isolation; the dispatch gates it back
 * to the legacy coordinator. */
export function elementArgumentUsage(
  elementBuilt: BuiltRog,
): {
  usesElement: boolean;
  usesIndex: boolean;
  usesArray: boolean;
  usesParams: boolean;
} {
  const heads = new Set<string>();
  const noteArgRef = (ref: { kind: string; path?: readonly string[] }) => {
    if (ref.kind !== "argument") return;
    if (ref.path && ref.path.length > 0) heads.add(ref.path[0]);
    else {
      heads.add("element");
      heads.add("index");
      heads.add("array");
      heads.add("params");
    }
  };
  const scan = (built: BuiltRog) => {
    // The RESULT expression reads too (a pure projection element like
    // `(item) => item.v` has ZERO ops — its result ref IS the argument read).
    noteArgRef(built.rog.result);
    for (const op of built.rog.ops) {
      const refs = [...op.inputs];
      const d = op.detail;
      if (d.kind === "collection") refs.push(d.listInput);
      if (d.kind === "pattern") refs.push(d.argument);
      if (d.kind === "control") {
        refs.push(d.pred);
        if (d.then !== "pred") refs.push(d.then);
        if (d.else !== "pred") refs.push(d.else);
      }
      if (d.kind === "construct") {
        const t = d.template;
        refs.push(
          ...(t.shape === "object" ? Object.values(t.fields) : t.items),
        );
      }
      for (const ref of refs) noteArgRef(ref);
    }
    for (const child of built.children.values()) scan(child);
  };
  scan(elementBuilt);
  return {
    usesElement: heads.has("element"),
    usesIndex: heads.has("index"),
    usesArray: heads.has("array"),
    usesParams: heads.has("params"),
  };
}

/** The synthetic raw-node implementation for one eligible inline `map`. */
export function makeInlineMapImplementation(
  elementBuilt: BuiltRog,
  _elementFactory: unknown,
  elementResultSchema: JSONSchema | undefined,
  usage: { usesElement: boolean; usesIndex: boolean; usesParams: boolean },
) {
  return function ri2InlineMap(
    inputsCell: Cell<{ list: unknown[]; op: unknown; params?: unknown }>,
    sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    addCancel: AddCancel,
    _cause: unknown,
    // deno-lint-ignore no-explicit-any
    parentCell: Cell<any>,
    runtime: Runtime,
    outputBinding?: NormalizedFullLink,
    awaitSync?: boolean,
  ): Action {
    // deno-lint-ignore no-explicit-any
    let result: Cell<any> | undefined;
    const containerSchema = listResultSchema(elementResultSchema);
    // MONOTONIC DEGRADE to the REAL legacy coordinator (identical raw-impl
    // signature + identical container cause, so the handoff is seamless):
    // scoped lists/elements and runtime op swaps are the legacy machinery's
    // territory (v1 D-EMISSION-SCOPE). Once degraded, stay degraded.
    let legacyAction: Action | undefined;
    const degrade = (): Action => {
      legacyAction ??= legacyMapBuiltin(
        // deno-lint-ignore no-explicit-any
        inputsCell as unknown as Cell<any>,
        sendResult,
        addCancel,
        _cause as never,
        parentCell,
        runtime,
        outputBinding,
        awaitSync,
      ) as unknown as Action;
      return legacyAction;
    };
    // LEGACY-PARITY element identity (map.ts elementRuns): per-element runs
    // keyed by the element's resolved link identity + duplicate occurrence,
    // so an element's result cell FOLLOWS the element across position
    // changes (mid-list insert reuses runs; only usesIndex re-runs).
    const elementRuns = new Map<string, {
      // deno-lint-ignore no-explicit-any
      resultCell: Cell<any>;
      lastIndex: number;
      cancel?: Cancel;
    }>();
    let resumeAwaitSync = !!awaitSync;

    // Cancel the inline per-element work and hand the coordinator over to
    // the legacy builtin permanently.
    const degradeNow = (tx: IExtendedStorageTransaction): void => {
      for (const run of elementRuns.values()) run.cancel?.();
      elementRuns.clear();
      degrade()(tx);
    };

    return (tx: IExtendedStorageTransaction) => {
      if (legacyAction) return legacyAction(tx);
      const probeScoped = <T>(fn: () => T): T =>
        tx.runWithAmbientReadMeta(linkResolutionProbe, fn);

      // RUNTIME OP RESOLUTION, before ANY output write (legacy resolves the
      // op first): an unresolvable sentinel fails LOUDLY exactly as legacy.
      // No identity comparison: a runtime op SWAP is impossible on this path
      // (a dynamic op arrives as a Reactive, which already refused inline at
      // plan time; a static op binding is by-construction the build-time
      // element), and an embedded-graph op deserializes to a fresh un-noted
      // object that would false-mismatch.
      {
        const rawOp = probeScoped(() =>
          inputsCell.key("op").withTx(tx).getRaw() as unknown
        );
        resolveOpPattern(runtime, rawOp, "map");
      }

      // Identity-only list materialization (coordinator flow-join stays
      // empty; membership/order ARE the list's content).
      const listCell = probeScoped(() =>
        inputsCell.key("list").withTx(tx).resolveAsCell()
      );
      const listScope = resolveLink(
        runtime,
        tx,
        inputsCell.key("list").getAsNormalizedFullLink(),
        "writeRedirect",
      ).scope;
      // Scoped lists are the legacy machinery's territory (per-element
      // child materialization at element scope, session boxing, ...).
      if ((listScope ?? "space") !== "space") return degradeNow(tx);

      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error("ri2InlineMap: needs a write-redirect output spot");
        }
        // LEGACY-PARITY container identity: same cause as map.ts, so a flag
        // flip mid-life resolves the same container.
        // deno-lint-ignore no-explicit-any
        const baseResult = runtime.getCell<any>(
          parentCell.space,
          { map: parentCell.entityId, outputSpot },
          containerSchema,
          tx,
        );
        result = scopedCell(runtime, tx, baseResult, listScope);
        setResultCell(result, parentCell);
        setPatternCell(result, parentCell.key("pattern"));
        sendResult(tx, result);
      }
      const resultCell = result;
      const resultPresence = resultCell.asSchema(RESULT_PRESENCE_SCHEMA);

      // Resume-against-confirmed-state guard (legacy map.ts parity): on the
      // resume reconcile an undefined container is its durable value still
      // streaming in — reconciling now writes a stale basis (the reload
      // commit storm). Pull and defer; arrival re-triggers this reconcile.
      if (
        resumeAwaitSync &&
        probeScoped(() => resultPresence.withTx(tx).get()) === undefined
      ) {
        runtime.storageManager.trackUntilSettled(
          resultCell.sync().then(() =>
            runtime.editWithRetry((seedTx) => {
              const container = resultCell.withTx(seedTx);
              if (container.getRaw() === undefined) container.set([]);
            }).then(() => undefined)
          ).catch(() => undefined),
        );
        return;
      }

      const rawList = probeScoped(() =>
        listCell.withTx(tx).getRaw() as unknown
      );
      // Legacy parity: an undefined input list → empty container + stop the
      // per-element work (map.ts's undefined-input cleanup).
      if (rawList === undefined) {
        probeScoped(() => resultPresence.withTx(tx).set([]));
        for (const run of elementRuns.values()) run.cancel?.();
        elementRuns.clear();
        return;
      }
      const len = Array.isArray(rawList) ? rawList.length : 0;
      if (len > 0) resumeAwaitSync = false;

      const slotLink = (i: number): NormalizedFullLink =>
        probeScoped(() => {
          const elemCell = listCell.key(i as never).withTx(tx).resolveAsCell();
          return resolveLink(
            runtime,
            tx,
            elemCell.getAsNormalizedFullLink(),
            "value",
          );
        });

      const keyCounts = new Map<string, number>();
      // deno-lint-ignore no-explicit-any
      const slots = new Array<any>(len);
      for (let i = 0; i < len; i++) {
        // Sparse-hole guard (legacy parity: no doc/effect for holes).
        if (!(i in (rawList as unknown[]))) continue;
        const index = i;
        const link = slotLink(index);
        // LEGACY element identity (cellIdentityKey + occurrence counting):
        // the resolved link identity keys the run, so results follow
        // elements across positions; duplicates get per-occurrence runs.
        const linkKey = [link.space, link.id, link.scope, link.path] as const;
        const dedupKey = JSON.stringify(linkKey);
        const occurrence = keyCounts.get(dedupKey) ?? 0;
        keyCounts.set(dedupKey, occurrence + 1);
        const elementKey = JSON.stringify([...linkKey, occurrence]);

        // A non-space-scoped ELEMENT is legacy territory too.
        if ((link.scope ?? "space") !== "space") return degradeNow(tx);
        let run = elementRuns.get(elementKey);
        if (!run) {
          // Same cause shape as legacy map.ts (`{ map: result, elementKey }`)
          // so a flag flip mid-life resolves the same per-element cells.
          // deno-lint-ignore no-explicit-any
          const elemResult = runtime.getCell<any>(
            parentCell.space,
            { map: resultCell, elementKey },
            undefined,
            tx,
          );
          setResultCell(elemResult, parentCell);
          setPatternCell(elemResult, parentCell.key("pattern"));
          run = { resultCell: elemResult, lastIndex: -1 };
          elementRuns.set(elementKey, run);
        }

        // (Re)subscribe when new, or when the element's INDEX moved and the
        // element actually uses it (legacy re-runs exactly then).
        const needsSubscribe = !run.cancel ||
          (usage.usesIndex && run.lastIndex !== index);
        if (needsSubscribe) {
          run.cancel?.();
          const elemResult = run.resultCell;
          const elementAction: Action = (childTx) => {
            // Read ONLY this slot in its own tx → pointwise label isolation.
            const elemValue = runtime.getCellFromLink(
              link,
              undefined,
              childTx,
            )!.withTx(childTx).get() as unknown;
            const argument: Record<string, unknown> = {};
            if (usage.usesElement) argument.element = elemValue;
            if (usage.usesIndex) argument.index = index;
            if (usage.usesParams) {
              argument.params = inputsCell.key("params").withTx(childTx)
                .get();
            }
            // THE INLINE: the element's whole ROG evaluates here — no child
            // pattern, no child arg/process docs.
            const { result: out, errors } = evalRog(elementBuilt.rog, {
              argument,
              leafImpls: elementBuilt.leafImpls,
              children: elementBuilt.children,
            });
            if (RI2_DEBUG) {
              console.log(
                `[ri2] map-elem ${index}: arg=${JSON.stringify(argument)} ` +
                  `out=${JSON.stringify(out)} errors=${errors.length}`,
              );
            }
            // §4.8 consolidated element write: the whole subtree (VNodes
            // included) stores INLINE in this one element doc.
            elemResult.withTx(childTx).setRawUntyped(
              fabricFromNativeValue(convertCellsToLinks(out)),
            );
          };
          run.cancel = runtime.scheduler.subscribe(
            elementAction,
            {
              reads: [toMemorySpaceAddress(link)],
              shallowReads: [],
              writes: [
                toMemorySpaceAddress(elemResult.getAsNormalizedFullLink()),
              ],
            },
            { isEffect: true },
          );
          addCancel(run.cancel);
        }
        run.lastIndex = index;
        // Legacy slot shape: the exposed (scope-aware) view of the element
        // result cell.
        slots[index] = exposedResultCell(runtime, tx, run.resultCell);
      }
      // Legacy parity: absent elements KEEP their runs (reuse on reappear;
      // stopped at dispose via addCancel). The container no longer links
      // them, so they are unobservable meanwhile.

      // Pure-link-structure container write (probe-scoped diffing).
      probeScoped(() =>
        resultPresence.withTx(tx).set(slots as unknown as unknown[])
      );
    };
  };
}
