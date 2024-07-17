import {
  CONFIDENTIAL_COMPUTE_SANDBOX,
  SES_SANDBOX,
  WASM_SANDBOX
} from "@commontools/runtime";

export type EvalMode =
  | typeof WASM_SANDBOX
  | typeof SES_SANDBOX
  | typeof CONFIDENTIAL_COMPUTE_SANDBOX;

export type NodeId = string;

export type Recipe = {
  inputs: NodeId[];
  outputs: NodeId[];
  nodes: RecipeNode[];
  connections: RecipeConnectionMap;
};
export type ConnectionMap = { [port: string]: string };
export type RecipeConnectionMap = { [nodeId: string]: ConnectionMap };

export type RecipeNode = {
  id: string;
  contentType: string;
  docstring: string;
  body: any;
  staleDocstring?: boolean;
  staleBody?: boolean;
  evalMode?: EvalMode;
};

export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};
