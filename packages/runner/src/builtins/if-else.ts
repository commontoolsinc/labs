import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { resolveLink } from "../link-resolution.ts";
import { resolvedCellScope, scopedCell } from "./scope-policy.ts";
import { parseLink } from "../link-utils.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

/**
 * Argument schema for ifElse. The action value-reads ONLY `condition`; the
 * `ifTrue`/`ifFalse` branches are pass-through references — the action resolves
 * a LINK to the selected branch and forwards it, never reading the branch
 * VALUE. Marking the branches `asCell: ["opaque"]` lets the runner drop those
 * keys from this node's declared reads (via `opaqueArgumentKeys` +
 * `findAllWriteRedirectCells`'s `skipTopLevelKeys`), so the (possibly
 * unselected) branch writer is no longer pulled at settle. The selected branch
 * is still scheduled by the DOWNSTREAM reader of ifElse's result (it follows
 * the result link and demands the branch's value), independent of ifElse's own
 * declared reads.
 *
 * `condition` stays a plain (value-read) input, so a condition change keeps
 * re-running ifElse.
 */
export const IF_ELSE_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    condition: { type: "unknown" },
    ifTrue: { type: "unknown", asCell: ["opaque"] },
    ifFalse: { type: "unknown", asCell: ["opaque"] },
  },
});

export function ifElse(
  inputsCell: Cell<[any, any, any]>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): RawBuiltinResult {
  const readCondition = (tx: IExtendedStorageTransaction) => {
    const conditionCell = inputsCell.key("condition");
    const resolvedCondition = resolveLink(
      runtime,
      tx,
      conditionCell.getAsNormalizedFullLink(),
    );
    const cell = runtime.getCellFromLink(resolvedCondition).withTx(tx);
    return { cell, value: cell.get() };
  };

  const action: Action = (tx: IExtendedStorageTransaction) => {
    const { cell: conditionCell, value: condition } = readCondition(tx);
    const resultScope = resolvedCellScope(runtime, tx, conditionCell);
    const baseResult = runtime.getCell<any>(
      parentCell.space,
      { ifElse: cause },
      undefined,
      tx,
    );
    const result = scopedCell(runtime, tx, baseResult, resultScope);
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const ref = inputsWithLog.key(condition ? "ifTrue" : "ifFalse")
      .getAsLink({ base: result });
    const resolvedRef = resolveLink(runtime, tx, parseLink(ref, result));
    const serializedRef = runtime.getCellFromLink(resolvedRef).getAsLink({
      base: result,
    });

    // When writing links, we need to use setRawUntyped (link doesn't match T)
    resultWithLog.setRawUntyped(serializedRef);
  };

  return {
    action,
  };
}
