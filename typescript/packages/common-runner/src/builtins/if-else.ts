import { type Node } from "@commontools/common-builder";
import {
  cell,
  getCellReferenceOrThrow,
  type CellImpl,
  type ReactivityLog,
} from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, type Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";

export function ifElse(recipeCell: CellImpl<any>, { inputs, outputs }: Node) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as [
    any,
    any,
    any
  ];
  const inputsCell = cell(inputBindings);

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any;

  const result = cell<any>(undefined);

  const checkCondition: Action = (log: ReactivityLog) => {
    const condition = inputsCell.getAsProxy([0], log);

    const ref = getCellReferenceOrThrow(
      inputsCell.getAsProxy([condition ? 1 : 2], log)
    );
    result.send(ref.cell.getAsProxy(ref.path), log);
  };

  sendValueToBinding(recipeCell, outputBindings, result);

  schedule(checkCondition, {
    reads: findAllAliasedCells(inputBindings[0], recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}
