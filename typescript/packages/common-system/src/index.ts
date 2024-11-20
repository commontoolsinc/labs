export { h, Fragment } from "./jsx.js";
export * from "./adapter.js";
export * from "./rule-builder.js";
export * from "./view.js";
export * from "synopsys";
import { Var, Constant, API } from "datalogia";

export const isTerm = (value: unknown): value is API.Term =>
  Var.is(value) || Constant.is(value);
