import { type CellImpl } from "../cell.js";
import { type Action } from "../scheduler.js";
import { map } from "./map.js";
import { fetchData } from "./fetch-data.js";
import { streamData } from "./stream-data.js";
import { llm } from "./llm.js";
import { ifElse } from "./if-else.js";
export const builtins: {
  [key: string]: (
    inputsCell: CellImpl<any>,
    sendResult: (result: any) => void
  ) => Action;
} = {
  map,
  fetchData,
  streamData,
  llm,
  ifElse,
};
