import { type Node } from "@commontools/common-builder";
import { type CellImpl } from "../cell.js";
import { map } from "./map.js";
import { fetchData } from "./fetch-data.js";
import { streamData } from "./stream-data.js";
import { generateText } from "./generate-text.js";
import { ifElse } from "./if-else.js";
export const builtins: {
  [key: string]: (recipeCell: CellImpl<any>, node: Node) => void;
} = {
  map,
  fetchData,
  streamData,
  generateText,
  ifElse,
};
