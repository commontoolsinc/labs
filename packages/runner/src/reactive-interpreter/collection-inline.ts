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
import {
  isPrimitiveCellLink,
  parseLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import { linkResolutionProbe } from "../storage/reactivity-log.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel, Cancel } from "../cancel.ts";
import type { Cell, JSONSchema } from "../builder/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { resolveOpPattern } from "../builtins/op-pattern-ref.ts";
import { map as legacyMapBuiltin } from "../builtins/map.ts";
import { filter as legacyFilterBuiltin } from "../builtins/filter.ts";
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

      // UNMARKED read (legacy map.ts parity): membership/order ARE the
      // list's content — a value-class read that does NOT consume the
      // per-slot link-origin labels. Probe-marking this root read would
      // make it a followRef observation post-C1, joining every element's
      // source label into the coordinator's J (the pointwise smear).
      const rawList = listCell.withTx(tx).getRaw() as unknown;
      // RESUME-INPUT guard (legacy awaitInputThenSettle parity): on a resume
      // reconcile the input list may be undefined/transiently empty while
      // its durable value streams in — blanking the persisted container now
      // would clobber it. Hold and await the input; its arrival re-triggers
      // this reconcile via the journaled read above.
      const priorSlots = probeScoped(() => resultPresence.withTx(tx).get());
      const priorLen = Array.isArray(priorSlots) ? priorSlots.length : 0;
      const listPending = rawList === undefined ||
        (Array.isArray(rawList) && rawList.length === 0);
      if (resumeAwaitSync && priorLen > 0 && listPending) {
        // Legacy awaitInputThenSettle: await the input; once CONFIRMED
        // empty, clear the container (a non-empty confirmation re-triggers
        // this reconcile via the journaled read instead).
        runtime.storageManager.trackUntilSettled(
          listCell.sync().then(() =>
            runtime.editWithRetry((settleTx) => {
              const raw = settleTx.runWithAmbientReadMeta(
                linkResolutionProbe,
                () => listCell.withTx(settleTx).getRaw() as unknown,
              );
              if (
                raw === undefined ||
                (Array.isArray(raw) && raw.length === 0)
              ) {
                settleTx.runWithAmbientReadMeta(
                  linkResolutionProbe,
                  () =>
                    resultCell.asSchema(RESULT_PRESENCE_SCHEMA)
                      .withTx(settleTx).set([]),
                );
              }
            }).then(() => undefined)
          ).catch(() => undefined),
        );
        return;
      }
      // Legacy parity: an undefined input list → empty container + stop the
      // per-element work (map.ts's undefined-input cleanup).
      if (rawList === undefined) {
        probeScoped(() => resultPresence.withTx(tx).set([]));
        for (const run of elementRuns.values()) run.cancel?.();
        elementRuns.clear();
        return;
      }
      if (!Array.isArray(rawList)) {
        // Legacy parity (map.ts): a defined non-array list is a loud error.
        throw new Error("map currently only supports arrays");
      }
      const len = rawList.length;
      if (len > 0) resumeAwaitSync = false;

      // Identity-only slot links (legacy map.ts parity, observation classes
      // C1): build element links from the RAW slots directly — the asCell
      // traversal's terminal probe at the element root belongs to no
      // recorded dereference, so post-C1 it becomes a contributing
      // followRef observation and smears every element's label into the
      // coordinator's per-tx join. resolveLink's own probes belong to the
      // dereferences it records; no element value is loaded at all.
      const listBase = listCell.getAsNormalizedFullLink();
      const slotLink = (i: number): NormalizedFullLink => {
        const slot = (rawList as unknown[])[i];
        // The list's own schema must NOT ride along to an element path (an
        // array schema applied at an element reads undefined); elements are
        // read schema-free by the effect.
        const raw: NormalizedFullLink = isPrimitiveCellLink(slot)
          ? parseLink(slot, listBase)
          : {
            ...listBase,
            path: [...listBase.path, String(i)],
            schema: undefined,
          };
        return resolveLink(runtime, tx, raw, "value");
      };

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
          // A params change must re-run the element (bot finding P1): the
          // params read happens inside the element tx, but the SUBSCRIPTION
          // must declare it too.
          const paramsAddr = usage.usesParams
            ? toMemorySpaceAddress(
              inputsCell.key("params").getAsNormalizedFullLink(),
            )
            : undefined;
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
            elemResult.withTx(childTx).setRawUntyped(
              fabricFromNativeValue(convertCellsToLinks(out)),
            );
            // Surface isolated element errors to scheduler.onError (bot
            // finding P2), matching the segment protocol: the write above
            // survives; the throw notifies handlers.
            if (errors.length > 0) throw errors[0].error;
          };
          run.cancel = runtime.scheduler.subscribe(
            elementAction,
            {
              reads: paramsAddr
                ? [toMemorySpaceAddress(link), paramsAddr]
                : [toMemorySpaceAddress(link)],
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

/** The synthetic raw-node implementation for one eligible inline `filter`.
 *
 * Per element, a read-isolated effect evaluates the PREDICATE ROG and
 * writes its result to a per-element predicate cell; the coordinator keeps
 * the ORIGINAL element links where the predicate settled truthy, drops
 * defined-falsy, and treats undefined as still-pending (the journaled
 * predicate read re-triggers the rebuild when it lands — legacy's two-pass
 * convergence, minus the child-pattern latency).
 *
 * RESUMED coordinators degrade to the legacy builtin IMMEDIATELY: the
 * resume-republish/recovery machinery (stale aggregates vs streaming
 * predicate cells) stays on the battle-tested path; fresh runtimes get the
 * inline win.
 */
export function makeInlineFilterImplementation(
  elementBuilt: BuiltRog,
  _elementFactory: unknown,
  usage: { usesElement: boolean; usesIndex: boolean; usesParams: boolean },
) {
  return function ri2InlineFilter(
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
    let legacyAction: Action | undefined;
    const degrade = (): Action => {
      legacyAction ??= legacyFilterBuiltin(
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
    const elementRuns = new Map<string, {
      // deno-lint-ignore no-explicit-any
      predicateCell: Cell<any>;
      lastIndex: number;
      cancel?: Cancel;
    }>();
    const degradeNow = (tx: IExtendedStorageTransaction): void => {
      for (const run of elementRuns.values()) run.cancel?.();
      elementRuns.clear();
      degrade()(tx);
    };

    return (tx: IExtendedStorageTransaction) => {
      if (legacyAction) return legacyAction(tx);
      // Resume machinery stays legacy (see module doc).
      if (awaitSync) return degradeNow(tx);
      const probeScoped = <T>(fn: () => T): T =>
        tx.runWithAmbientReadMeta(linkResolutionProbe, fn);

      {
        const rawOp = probeScoped(() =>
          inputsCell.key("op").withTx(tx).getRaw() as unknown
        );
        resolveOpPattern(runtime, rawOp, "filter");
      }

      const listCell = probeScoped(() =>
        inputsCell.key("list").withTx(tx).resolveAsCell()
      );
      const listScope = resolveLink(
        runtime,
        tx,
        inputsCell.key("list").getAsNormalizedFullLink(),
        "writeRedirect",
      ).scope;
      if ((listScope ?? "space") !== "space") return degradeNow(tx);

      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error("ri2InlineFilter: needs an output binding");
        }
        // deno-lint-ignore no-explicit-any
        const baseResult = runtime.getCell<any>(
          parentCell.space,
          { filter: parentCell.entityId, outputSpot },
          listResultSchema(),
          tx,
        );
        if (RI2_DEBUG) {
          console.log(
            `[ri2] filter-container id=${
              baseResult.getAsNormalizedFullLink().id.slice(-16)
            } parent=${String(parentCell.entityId).slice(-16)}`,
          );
        }
        result = scopedCell(runtime, tx, baseResult, listScope);
        setResultCell(result, parentCell);
        setPatternCell(result, parentCell.key("pattern"));
        sendResult(tx, result);
      }
      const resultCell = result;
      const resultPresence = resultCell.asSchema(RESULT_PRESENCE_SCHEMA);

      const rawList = probeScoped(() =>
        listCell.withTx(tx).getRaw() as unknown
      );
      if (rawList === undefined) {
        probeScoped(() => resultPresence.withTx(tx).set([]));
        for (const run of elementRuns.values()) run.cancel?.();
        elementRuns.clear();
        return;
      }
      if (!Array.isArray(rawList)) {
        throw new Error("filter currently only supports arrays");
      }
      const len = rawList.length;

      // Identity-only slot links, LIKE LEGACY's cellIdentityKey form: for an
      // inline value the element identity is the LIST DOC PATH (["items",i]),
      // which is exactly the elementKey the legacy filter derives — so the
      // predicate cells `{filter: result, elementKey}` are THE SAME DOCS a
      // degraded/legacy coordinator's children resolve. That identity match
      // is load-bearing for resume: a degraded coordinator's batch reconcile
      // is REVERTIBLE (stale withheld-container basis) and legacy never
      // re-runs deduped children, so the durable predicate values A left
      // behind are the only copies B can converge from. (The asCell
      // traversal instead minted content-addressed `data:` identities —
      // mismatching legacy's keys and stranding the resume at [].)
      const listBase = listCell.getAsNormalizedFullLink();
      const slotLink = (i: number): NormalizedFullLink => {
        const slot = (rawList as unknown[])[i];
        const raw: NormalizedFullLink = isPrimitiveCellLink(slot)
          ? parseLink(slot, listBase)
          : {
            ...listBase,
            path: [...listBase.path, String(i)],
            schema: undefined,
          };
        return resolveLink(runtime, tx, raw, "value");
      };

      const keyCounts = new Map<string, number>();
      // deno-lint-ignore no-explicit-any
      const kept: any[] = [];
      let firstInlineError: { error: unknown } | undefined;
      for (let i = 0; i < len; i++) {
        if (!(i in (rawList as unknown[]))) continue;
        const index = i;
        const link = slotLink(index);
        if ((link.scope ?? "space") !== "space") return degradeNow(tx);
        const linkKey = [link.space, link.id, link.scope, link.path] as const;
        const dedupKey = JSON.stringify(linkKey);
        const occurrence = keyCounts.get(dedupKey) ?? 0;
        keyCounts.set(dedupKey, occurrence + 1);
        const elementKey = JSON.stringify([...linkKey, occurrence]);

        const evalPredicateIn = (
          evalTx: IExtendedStorageTransaction,
        ): { out: unknown; errors: { error: unknown }[] } => {
          const elemValue = runtime.getCellFromLink(
            link,
            undefined,
            evalTx,
          )!.withTx(evalTx).get() as unknown;
          const argument: Record<string, unknown> = {};
          if (usage.usesElement) argument.element = elemValue;
          if (usage.usesIndex) argument.index = index;
          if (usage.usesParams) {
            argument.params = inputsCell.key("params").withTx(evalTx).get();
          }
          const { result: out, errors } = evalRog(elementBuilt.rog, {
            argument,
            leafImpls: elementBuilt.leafImpls,
            children: elementBuilt.children,
          });
          return { out, errors };
        };

        let run = elementRuns.get(elementKey);
        let freshRun = false;
        if (!run) {
          freshRun = true;
          // COLLIDING cause with legacy's child-result docs, ON PURPOSE: for
          // a withheld-container resume, a (dispatch-degraded) legacy
          // coordinator can only converge from durable per-element docs at
          // ITS child ids — `included = childCell.get()` reads these
          // booleans exactly like child results. (A non-colliding cause
          // strands that resume at []: children instantiate inside the
          // revertible batch reconcile and legacy dedups them forever.)
          // deno-lint-ignore no-explicit-any
          const predicateCell = runtime.getCell<any>(
            parentCell.space,
            { filter: resultCell, elementKey },
            undefined,
            tx,
          );
          setResultCell(predicateCell, parentCell);
          run = { predicateCell, lastIndex: -1 };
          elementRuns.set(elementKey, run);
          // Legacy batch-first-instantiation parity (CFC §8.5.6.1): an
          // element's FIRST predicate evaluation runs inline in the
          // coordinator's own tx, so the container write that decides its
          // membership joins the element's content label — the membership
          // structure stamp must be as confidential as the values that
          // decided it, even when the container value is `[]` or later
          // diffs never touch the root again. Subsequent element changes
          // go through the per-element effect (pointwise labels).
          // Deliberately NOT probe-scoped: the content read IS the taint.
          const { out, errors } = evalPredicateIn(tx);
          predicateCell.withTx(tx).setRawUntyped(
            fabricFromNativeValue(convertCellsToLinks(out)),
          );
          if (errors.length > 0) firstInlineError ??= errors[0];
        }
        const needsSubscribe = !run.cancel ||
          (usage.usesIndex && run.lastIndex !== index);
        if (needsSubscribe) {
          run.cancel?.();
          const predicateCell = run.predicateCell;
          const paramsAddr = usage.usesParams
            ? toMemorySpaceAddress(
              inputsCell.key("params").getAsNormalizedFullLink(),
            )
            : undefined;
          const elementAction: Action = (childTx) => {
            const { out, errors } = evalPredicateIn(childTx);
            predicateCell.withTx(childTx).setRawUntyped(
              fabricFromNativeValue(convertCellsToLinks(out)),
            );
            if (errors.length > 0) throw errors[0].error;
          };
          const log = {
            reads: paramsAddr
              ? [toMemorySpaceAddress(link), paramsAddr]
              : [toMemorySpaceAddress(link)],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(predicateCell.getAsNormalizedFullLink()),
            ],
          };
          if (freshRun) {
            // The inline eval above already computed THIS input state —
            // register triggers for FUTURE changes only, or every
            // predicate would run twice on first sight (legacy runs each
            // exactly once).
            runtime.scheduler.resubscribe(elementAction, log, {
              isEffect: true,
            });
            run.cancel = () => runtime.scheduler.unsubscribe(elementAction);
          } else {
            // Index moved on a live run: legacy re-runs exactly then, so
            // the initial-run subscribe is the parity path.
            run.cancel = runtime.scheduler.subscribe(elementAction, log, {
              isEffect: true,
            });
          }
          addCancel(run.cancel);
        }
        run.lastIndex = index;

        // Legacy contribute(): keep the ORIGINAL element where the predicate
        // settled truthy; drop defined-falsy; undefined = pending (the
        // journaled read below re-triggers this rebuild when it lands).
        const included = run.predicateCell.withTx(tx).get() as unknown;
        if (RI2_DEBUG) {
          console.log(
            `[ri2] filter-elem ${index}: included=${
              JSON.stringify(included)
            }`,
          );
        }
        if (included) {
          kept.push(
            exposedResultCell(
              runtime,
              tx,
              runtime.getCellFromLink(link, undefined, tx)!,
            ),
          );
        }
      }

      probeScoped(() => resultPresence.withTx(tx).set(kept));
      // Segment/effect protocol: the writes above survive; the throw
      // surfaces the first inline predicate error to scheduler.onError.
      if (firstInlineError !== undefined) throw firstInlineError.error;
    };
  };
}
