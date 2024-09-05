import { type Node } from "../../builder/index.js";
import {
  cell,
  CellImpl,
  CellReference,
  ReactivityLog,
  getCellReferenceOrValue,
} from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";

export function ifElse(recipeCell: CellImpl<any>, { inputs, outputs }: Node) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as [
    any,
    any,
    any
  ];
  const inputsCell = cell(inputBindings);

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any;

  const result = cell<CellReference>(undefined);

  const checkCondition: Action = (log: ReactivityLog) => {
    const [condition, ifTrue, ifFalse] = inputsCell.getAsProxy([], log);

    result.send(getCellReferenceOrValue(condition ? ifTrue : ifFalse), log);

    sendValueToBinding(recipeCell, outputBindings, result, log);
  };

  schedule(checkCondition, {
    reads: findAllAliasedCells(inputBindings[0], recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}
