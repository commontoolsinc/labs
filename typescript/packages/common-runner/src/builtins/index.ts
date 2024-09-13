import { type Node } from "@commontools/common-builder";
import { type CellImpl } from "../cell.js";
import { map } from "./map.js";
import { generateData } from "./generate-data.js";
import { ifElse } from "./if-else.js";
export const builtins: {
  [key: string]: (recipeCell: CellImpl<any>, node: Node) => void;
} = {
  map,
  generateData,
  ifElse,
};
