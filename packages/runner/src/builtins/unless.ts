import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { resolveLink } from "../link-resolution.ts";
import { resolvedCellScope, scopedCell } from "./scope-policy.ts";
import { parseLink } from "../link-utils.ts";
import type { CellScope } from "../builder/types.ts";

const CONDITIONAL_RESULT_SCOPES: readonly CellScope[] = [
  "space",
  "user",
  "session",
];

/**
 * unless(condition, fallback) - || semantics
 * Returns condition if truthy, otherwise returns fallback
 */
export function unless(
  inputsCell: Cell<{ condition: any; fallback: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  const baseResultLink = runtime.getCell<any>(
    parentCell.space,
    { unless: cause },
  ).getAsNormalizedFullLink();
  const materializerWriteEnvelopes = CONDITIONAL_RESULT_SCOPES.map((scope) => ({
    ...baseResultLink,
    scope,
  }));

  const action: Action = (tx: IExtendedStorageTransaction) => {
    const conditionCell = inputsCell.key("condition");
    const resultScope = resolvedCellScope(runtime, tx, conditionCell);
    const baseResult = runtime.getCell<any>(
      parentCell.space,
      { unless: cause },
      undefined,
      tx,
    );
    const result = scopedCell(runtime, tx, baseResult, resultScope);
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    // || semantics: if truthy, return condition; if falsy, return fallback
    const ref = condition
      ? inputsWithLog.key("condition").getAsLink({ base: result })
      : inputsWithLog.key("fallback").getAsLink({ base: result });
    const resolvedRef = resolveLink(runtime, tx, parseLink(ref, result));
    const serializedRef = runtime.getCellFromLink(resolvedRef).getAsLink({
      base: result,
    });

    resultWithLog.setRawUntyped(serializedRef);
  };

  return {
    action,
    materializerWriteEnvelopes,
  };
}
