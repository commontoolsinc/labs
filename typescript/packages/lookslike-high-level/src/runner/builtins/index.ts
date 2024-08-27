import { type Node } from "../../builder/index.js";
import { type CellImpl } from "../cell.js";
import { map } from "./map.js";

export const builtins: {
  [key: string]: (recipeCell: CellImpl<any>, node: Node) => void;
} = {
  map,
};
