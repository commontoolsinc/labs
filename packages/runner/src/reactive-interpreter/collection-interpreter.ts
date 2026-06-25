/**
 * The COLLECTION interpreter builtin (production module for the reactive
 * interpreter's `collection` branch). Currently implements `op === "map"`.
 *
 * This is the productionized form of the W3 prototype that lived in
 * `test/reactive-interpreter/collection-interpret.test.ts` (`mapInterpreted`).
 * It is registered, flag-gated, as `$ri-collection-map` and dispatched to by the
 * runner's collection-eligibility branch (see `runner.ts`). Per element, a
 * scheduled effect reads ONLY element i (read-isolated → structurally pointwise)
 * and computes the element op by running `evalRog` over the element pattern's
 * ROG (leaves resolved through the harness verified-implementation index — NOT a
 * hardcoded leaf). It writes a per-element result document; the container holds
 * cell LINKS to them.
 *
 * Per DECISIONS.md D-W3-PRECISION (Option A): collections drop per-element child
 * PATTERNS but keep one result doc + one scheduled effect per element. ~3× fewer
 * docs/nodes than legacy (`~1+N` vs `~3N` docs), still O(N), sound, pointwise.
 *
 * CFC FIDELITY (must hold, else the per-element label precision smears):
 *   - the container write goes through a pure-link presence schema
 *     (`RESULT_PRESENCE_SCHEMA`: slots stay cell links → `isPureLinkStructure`
 *     true → structure-only stamps, never a derived smear);
 *   - the coordinator reads the list IDENTITY-ONLY under
 *     `tx.runWithAmbientReadMeta(linkResolutionProbe, ...)` so its flow-join J
 *     stays empty (no element content enters the coordinator tx);
 *   - each per-element effect runs in its OWN tx reading ONLY `slotLink(i)` → so
 *     element i's label rides element i's own result doc alone.
 *
 * Two productionizing swaps vs the prototype:
 *   1. the container item schema is derived from the element pattern's own
 *      `resultSchema` via `listResultSchema(elementResultSchema)` (rather than a
 *      hardcoded `{type:"object"}`), so downstream `.key(i)` consumers get the
 *      proper item schema;
 *   2. the builtin is parameterized by collection op (`collectionInterpreter(op)`),
 *      with everything but `map` reserved for later increments.
 */

import { internSchema } from "@commonfabric/data-model/schema-hash";
import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { listResultSchema } from "../builtins/list-result-schema.ts";
import { buildElementEvaluator } from "./element-evaluator.ts";
import { convertCellsToLinks } from "../cell.ts";
import { setResultCell } from "../result-utils.ts";
import { outputSpotFromBinding } from "../builtins/scope-policy.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import { linkResolutionProbe } from "../storage/reactivity-log.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel, Cancel } from "../cancel.ts";
import type { Cell, JSONSchema } from "../builder/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { CollectionOp } from "./rog.ts";

// Coordinator input schema: `list` slots stay cells (identity-only — the
// coordinator never reads element content), `op` is an opaque cell carrying the
// element pattern read raw.
const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

// Links-only view of the container: slots stay cell links so the coordinator's
// container write is PURE LINK STRUCTURE (no element content read → only
// `structure` stamps, never a smearing `derived` one).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

/**
 * Build the collection interpreter builtin for one collection op. Only `map` is
 * implemented in this increment; the runner's eligibility gate guarantees this
 * builtin is only ever reached for an eligible top-level `map`.
 */
export function collectionInterpreter(
  op: CollectionOp,
): (
  inputsCell: Cell<{ list: unknown[]; op: unknown }>,
  // deno-lint-ignore no-explicit-any
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: unknown,
  // deno-lint-ignore no-explicit-any
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
) => Action {
  if (op !== "map") {
    throw new Error(
      `collectionInterpreter: only "map" is implemented (got ${op})`,
    );
  }

  return function mapInterpreted(
    inputsCell,
    sendResult,
    addCancel,
    _cause,
    parentCell,
    runtime,
    outputBinding,
  ): Action {
    // deno-lint-ignore no-explicit-any
    let result: Cell<any> | undefined;
    let evaluate: ReturnType<typeof buildElementEvaluator> | undefined;
    // The container result schema is derived ONCE from the element pattern's own
    // resultSchema (productionizing swap #1): downstream `.key(i)` consumers get
    // the proper item schema rather than a bare `{type:"object"}`.
    let resultSchema: JSONSchema | undefined;
    let resultPresenceSchema: JSONSchema | undefined;
    // Per positional index: the slot-link identity key the index's effect is
    // currently subscribed against, plus its cancel. Positional keying (the
    // first-cut element key) with slot-identity-aware re-subscription so a
    // grow/shrink that REUSES an index at a DIFFERENT element re-points that
    // index's effect (otherwise a reused index keeps reading the old element).
    const subscribed = new Map<number, { key: string; cancel: Cancel }>();

    return (tx: IExtendedStorageTransaction) => {
      const mapped = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);

      if (!evaluate) {
        // Read the element pattern raw (the inline pattern graph; same idiom as
        // legacy map's `op.getRaw()`), and build the per-element evaluator ONCE.
        // This is the ROG path: extractRog + resolveLeafImpls + evalRog.
        const opRaw = mapped.key("op").getRaw() as unknown;
        // The graph read back from the cell is serialized: leaf bodies are no
        // longer live callables (only `$implRef` survives). Resolve those by
        // content-addressed ref — still NOT a hardcoded leaf: it is the actual
        // registered lift / `str` / builder-primitive body. Mirror the runner's
        // `interpreterImplRefResolver`: try the pattern-manager ARTIFACT index
        // first (which carries builder primitives like `str` that are not in the
        // harness's verified-implementation index), then fall back to the harness.
        // The runner's lowering eligibility probe uses the SAME two-tier resolver,
        // so a leaf that passes the gate also resolves here (no gate↔runtime skew).
        // deno-lint-ignore no-explicit-any
        const rt = runtime as any;
        const resolveImplRef = (identity: string, symbol: string) => {
          const artifact = rt.patternManager?.artifactFromIdentitySync?.(
            identity,
            symbol,
          );
          const fromArtifact = artifact &&
              typeof artifact.implementation === "function"
            ? artifact.implementation
            : typeof artifact === "function"
            ? artifact
            : undefined;
          if (fromArtifact) return fromArtifact;
          const verified = rt.harness?.getVerifiedImplementation?.(
            identity,
            symbol,
          );
          return typeof verified === "function" ? verified : undefined;
        };
        evaluate = buildElementEvaluator(
          opRaw as Record<string, unknown>,
          resolveImplRef,
          undefined,
          // Resolve the element's `element`/`index` argument aliases relative to
          // the parent map frame (`defer === 1`) — the authored
          // `array.map((value, index) => …)` element shape this builtin renders.
          true,
        );
        // Honest boundary check: an in-memory element pattern must fully
        // resolve. (The runner's eligibility probe already enforces this before
        // dispatch; this is a defensive belt-and-braces re-check.)
        if (evaluate.unresolvedLeafOps.length > 0) {
          throw new Error(
            `collectionInterpreter(map): unresolved element leaf ops ${
              JSON.stringify(evaluate.unresolvedLeafOps)
            } (serialized/SES boundary)`,
          );
        }
        // Productionizing swap #1: derive the container item schema from the
        // element pattern's own resultSchema so `.key(i)` consumers get the
        // proper item schema (positional keying preserved).
        const elementResultSchema =
          (opRaw as { resultSchema?: JSONSchema } | undefined)?.resultSchema;
        resultSchema = listResultSchema(elementResultSchema);
        resultPresenceSchema = RESULT_PRESENCE_SCHEMA;
      }
      const evaluateElement = evaluate;
      const containerSchema = resultSchema!;
      const presenceSchema = resultPresenceSchema!;

      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error("collectionInterpreter(map): needs output binding");
        }
        // deno-lint-ignore no-explicit-any
        result = runtime.getCell<any>(
          parentCell.space,
          { collectionInterpreter: parentCell.entityId, op, outputSpot },
          containerSchema,
          tx,
        );
        // Container write under the link-resolution-probe scope (mirrors legacy
        // map.ts's `probeScoped(() => resultWithLog.set(...))`): the slot diffing
        // materializes prior slot targets for identity comparison only, so no
        // element content read journals into the coordinator's flow-join J.
        tx.runWithAmbientReadMeta(linkResolutionProbe, () => result!.send([]));
        setResultCell(result, parentCell);
        sendResult(tx, result);
      }
      const resultCell = result;

      // Identity-only list materialization: read RAW slots under the
      // `linkResolutionProbe` scope so no element value enters the coordinator's
      // tx — its flow-join J stays empty.
      const listCell = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => inputsCell.key("list").withTx(tx).resolveAsCell(),
      );
      const rawList = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => listCell.withTx(tx).getRaw() as unknown,
      );
      const len = Array.isArray(rawList) ? rawList.length : 0;
      // Per-element slot link. Derive it via `listCell.key(i)` (schema-aware
      // navigation that follows any alias/redirect and an element cell-LINK slot)
      // rather than appending `[i]` to the raw `getAsNormalizedFullLink()` base:
      // when the list is a derived/segment output cell (the partition case — e.g.
      // a `normalizeItems(items)` lift feeding the map), a raw link-path append
      // resolves into the cell WRAPPER and reads `undefined` (the array root sits
      // behind the cell's own schema/redirect), whereas `key(i)` navigates to the
      // real element. `resolveAsCell()` + `getAsNormalizedFullLink()` then yields
      // the canonical per-element link the per-element effect subscribes on. (For
      // an inline-argument list — the single-node path — `key(i)` lands on the
      // same place the old append did, so behaviour is unchanged there.)
      const slotLink = (i: number): NormalizedFullLink =>
        tx.runWithAmbientReadMeta(linkResolutionProbe, () => {
          const elemCell = listCell.key(i as never).withTx(tx).resolveAsCell();
          return resolveLink(
            runtime,
            tx,
            elemCell.getAsNormalizedFullLink(),
            "value",
          );
        });

      const resultPresence = resultCell.asSchema(presenceSchema);
      // deno-lint-ignore no-explicit-any
      const slots = new Array<Cell<any>>(len);
      for (let i = 0; i < len; i++) {
        // Sparse-hole guard (legacy map.ts parity: `if (!(i in list)) continue`).
        // At a hole index, do NOT mint a per-element doc/effect/slot — running
        // the element op on `undefined` would write a spurious value (e.g.
        // double(undefined)=NaN) that fails item validation and drops the whole
        // field. Keep `len` so trailing positions are preserved; the slot stays a
        // hole in the container array, so `i in result` is false (sparseness
        // preserved by storage).
        if (!(i in (rawList as unknown[]))) continue;
        const index = i;
        // deno-lint-ignore no-explicit-any
        const elemResult = runtime.getCell<any>(
          parentCell.space,
          { collectionInterpreterElem: resultCell.entityId, op, index },
          undefined,
          tx,
        );
        slots[index] = elemResult;

        // The slot link for THIS index in THIS coordinator run (resolved once).
        const link = slotLink(index);
        const linkAddr = toMemorySpaceAddress(link);
        const key = JSON.stringify(linkAddr);
        const existing = subscribed.get(index);
        if (existing && existing.key === key) continue; // unchanged → keep sub
        // Slot identity changed (or first time): drop the stale subscription so
        // the effect re-points to the current element.
        if (existing) existing.cancel();

        const elementAction: Action = (childTx) => {
          // Read ONLY this slot (its own isolated tx → pointwise label). `link`
          // is the slot resolved for this subscription generation; a later
          // identity change re-subscribes with a fresh `link`.
          const elemValue = runtime.getCellFromLink(
            link,
            undefined,
            childTx,
          )!.withTx(childTx).get() as unknown;
          // ELEMENT OP VIA evalRog over the element ROG (not a hardcoded leaf).
          // Pass the positional `index` too (the `mapWithPattern` element pattern
          // exposes `{element, index}`); an element ignoring `index` never reads it.
          const out = evaluateElement(elemValue, index);
          // §4.8 CONSOLIDATED element-result write (legacy `updateResultProjection`
          // parity — runner.ts `writableResultCell.setRawUntyped(...)`). A plain
          // `.set()` runs `recursivelyAddIDIfNeeded`, which stamps `[ID]` on every
          // object sitting inside an array; for a rendered-VNode element result the
          // VNode `children` are arrays-of-objects, so each child VNode (`td`,
          // `cf-vstack`, every `span`) is then hoisted by `normalizeAndDiff`
          // `[BRANCH_ID_OBJECT]` into its OWN entity document → the per-element
          // result fragments into ~6 docs (the D-VNODE-DOC-FRAGMENTATION tax). A
          // RAW write stores the whole VNode subtree INLINE in this one element doc
          // (exactly what legacy's child-pattern render gets for free), so a
          // rendered map costs ONE consolidated doc/element. Scalar/object element
          // results (the W3 oracle's `{doubled:N}`) are unaffected: that object is
          // the doc root, never an object-inside-an-array, so it already lived
          // inline — a raw write of the same fabricized value is output-identical
          // and the docs/element slope only tightens. `convertCellsToLinks` first
          // turns any live Cell handles the element field reads produced into links
          // (mirrors what `.set()` would do via `recursivelyAddIDIfNeeded`'s
          // cell-link passthrough); `fabricFromNativeValue` deep-fabricizes the rest
          // (same call legacy uses). `setRawUntyped` records the schema-write policy
          // input for CFC; the element doc's schema is `undefined`, so the legacy
          // `recordSetupProjectionPolicyInputs` is a no-op here and the per-element
          // read-isolated tx already carries element i's flow-join label onto this
          // single doc — pointwise CFC parity is preserved.
          elemResult.withTx(childTx).setRawUntyped(
            fabricFromNativeValue(convertCellsToLinks(out)),
          );
        };
        setResultCell(elemResult, parentCell);
        const cancel = runtime.scheduler.subscribe(
          elementAction,
          {
            reads: [linkAddr],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(elemResult.getAsNormalizedFullLink()),
            ],
          },
          { isEffect: true },
        );
        addCancel(cancel);
        subscribed.set(index, { key, cancel });
      }
      // Reconcile shrink: cancel + drop effects for now-absent indices so a
      // later regrow re-subscribes them and they stop writing stale results.
      for (const tracked of [...subscribed.keys()]) {
        if (tracked >= len) {
          subscribed.get(tracked)!.cancel();
          subscribed.delete(tracked);
        }
      }
      // Pure-link-structure container write (empty coordinator J → only
      // `structure` stamps, never a smearing `derived` one). Under the
      // link-resolution-probe scope (mirrors legacy map.ts's
      // `probeScoped(() => resultWithLog.set(...))`): set() diffs prior slots as
      // links for identity comparison only, so the diff never journals a content
      // read of a prior element result into the coordinator's flow-join J.
      tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => resultPresence.withTx(tx).set(slots as unknown as unknown[]),
      );
    };
  };
}
