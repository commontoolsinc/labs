/**
 * TEST-ONLY deliberately-BROKEN mirror of the production collection-`map`
 * interpreter (`src/reactive-interpreter/collection-interpreter.ts`). It exists
 * ONLY so the prod-wire CFC oracle's pointwise assertion has TEETH at the
 * production-dispatch level: it proves that the per-element read-isolation the
 * real builtin enforces (each element effect reads ONLY `slotLink(i)` — a
 * single-slot read-set) is what keeps labels pointwise, and that the oracle
 * would CATCH a regression to a wider read-set.
 *
 * It is a faithful copy of the production builtin with EXACTLY ONE change: the
 * per-element scheduled effect ALSO reads `slotLink(i+1)` (a sibling), and its
 * scheduler read-set is widened to include that sibling address. Everything
 * else — identity-only coordinator list read under `linkResolutionProbe`,
 * per-element result docs, pure-link-structure container write, `evalRog` over
 * the element ROG resolved through the harness — is identical to production, so
 * the only thing that flips the oracle from "pointwise" to "smeared" is the
 * read-isolation violation. This MUST NOT be registered as `$ri-collection-map`
 * (it lives behind its own test ref); production code stays clean.
 *
 * Mirrors `src/reactive-interpreter/collection-interpreter.ts` as of the
 * map-wiring change — keep in sync structurally if that file's per-element
 * effect changes.
 */

import { internSchema } from "@commonfabric/data-model/schema-hash";
import { listResultSchema } from "../../src/builtins/list-result-schema.ts";
import { buildElementEvaluator } from "../../src/reactive-interpreter/element-evaluator.ts";
import { setResultCell } from "../../src/result-utils.ts";
import { outputSpotFromBinding } from "../../src/builtins/scope-policy.ts";
import {
  isPrimitiveCellLink,
  parseLink,
  toMemorySpaceAddress,
} from "../../src/link-utils.ts";
import { resolveLink } from "../../src/link-resolution.ts";
import { linkResolutionProbe } from "../../src/storage/reactivity-log.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { Action } from "../../src/scheduler.ts";
import type { AddCancel, Cancel } from "../../src/cancel.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";

const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

/**
 * Build the deliberately-broken collection-`map` interpreter. Read isolation is
 * VIOLATED: each per-element effect reads `slotLink(i)` AND `slotLink(i+1)`.
 */
export function brokenSiblingCollectionInterpreter(): (
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
  const op = "map" as const;
  return function mapInterpretedBrokenSibling(
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
    let resultSchema: JSONSchema | undefined;
    let resultPresenceSchema: JSONSchema | undefined;
    const subscribed = new Map<number, { key: string; cancel: Cancel }>();

    return (tx: IExtendedStorageTransaction) => {
      const mapped = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);

      if (!evaluate) {
        const opRaw = mapped.key("op").getRaw() as unknown;
        // deno-lint-ignore no-explicit-any
        const harness = (runtime as any).harness;
        evaluate = buildElementEvaluator(
          opRaw as Record<string, unknown>,
          (identity: string, symbol: string) =>
            harness?.getVerifiedImplementation?.(identity, symbol),
        );
        if (evaluate.unresolvedLeafOps.length > 0) {
          throw new Error(
            `brokenSiblingCollectionInterpreter: unresolved element leaf ops ${
              JSON.stringify(evaluate.unresolvedLeafOps)
            }`,
          );
        }
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
          throw new Error(
            "brokenSiblingCollectionInterpreter: needs output binding",
          );
        }
        // deno-lint-ignore no-explicit-any
        result = runtime.getCell<any>(
          parentCell.space,
          {
            brokenSiblingCollectionInterpreter: parentCell.entityId,
            op,
            outputSpot,
          },
          containerSchema,
          tx,
        );
        result.send([]);
        setResultCell(result, parentCell);
        sendResult(tx, result);
      }
      const resultCell = result;

      const listCell = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => inputsCell.key("list").withTx(tx).resolveAsCell(),
      );
      const listBase = listCell.getAsNormalizedFullLink();
      const rawList = tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => listCell.withTx(tx).getRaw() as unknown,
      );
      const len = Array.isArray(rawList) ? rawList.length : 0;
      const slotLink = (i: number): NormalizedFullLink => {
        const slot = (rawList as unknown[])[i];
        const link: NormalizedFullLink = isPrimitiveCellLink(slot)
          ? parseLink(slot, listBase)
          : { ...listBase, path: [...listBase.path, String(i)] };
        return tx.runWithAmbientReadMeta(
          linkResolutionProbe,
          () => resolveLink(runtime, tx, link, "value"),
        );
      };

      const resultPresence = resultCell.asSchema(presenceSchema);
      // deno-lint-ignore no-explicit-any
      const slots = new Array<Cell<any>>(len);
      for (let i = 0; i < len; i++) {
        const index = i;
        // deno-lint-ignore no-explicit-any
        const elemResult = runtime.getCell<any>(
          parentCell.space,
          {
            brokenSiblingCollectionInterpreterElem: resultCell.entityId,
            op,
            index,
          },
          undefined,
          tx,
        );
        slots[index] = elemResult;

        const link = slotLink(index);
        const linkAddr = toMemorySpaceAddress(link);
        // VIOLATION: also subscribe to the sibling slot (i+1) so its label
        // enters this element effect's tx flow-join. Production reads only
        // `[linkAddr]` (single-slot); this widened read-set is the regression
        // the oracle's pointwise assertion must catch.
        const siblingLink = index + 1 < len ? slotLink(index + 1) : undefined;
        const siblingAddr = siblingLink
          ? toMemorySpaceAddress(siblingLink)
          : undefined;
        const key = JSON.stringify([linkAddr, siblingAddr]);
        const existing = subscribed.get(index);
        if (existing && existing.key === key) continue;
        if (existing) existing.cancel();

        const elementAction: Action = (childTx) => {
          const elemValue = runtime.getCellFromLink(
            link,
            undefined,
            childTx,
          )!.withTx(childTx).get() as unknown;
          // VIOLATION: read the sibling element too (value discarded — the READ
          // is the leak: it pulls the sibling's label into this tx's flow-join).
          if (siblingLink) {
            runtime.getCellFromLink(
              siblingLink,
              undefined,
              childTx,
            )!.withTx(childTx).get();
          }
          const out = evaluateElement(elemValue);
          elemResult.withTx(childTx).set(out);
        };
        setResultCell(elemResult, parentCell);
        const reads = siblingAddr ? [linkAddr, siblingAddr] : [linkAddr];
        const cancel = runtime.scheduler.subscribe(
          elementAction,
          {
            reads,
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
      for (const tracked of [...subscribed.keys()]) {
        if (tracked >= len) {
          subscribed.get(tracked)!.cancel();
          subscribed.delete(tracked);
        }
      }
      resultPresence.withTx(tx).set(slots as unknown as unknown[]);
    };
  };
}
