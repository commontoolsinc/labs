import {
  CONFIDENTIAL_COMPUTE_SANDBOX,
  SES_SANDBOX,
  WASM_SANDBOX
} from "@commontools/runtime";

import {
  Subject,
  BehaviorSubject,
  Observable,
  combineLatest,
  Subscription
} from "rxjs";
import {
  debounceTime,
  distinct,
  filter,
  map,
  switchMap,
  take
} from "rxjs/operators";
import { CONTENT_TYPE_JAVASCRIPT } from "./contentType.js";

export type EvalMode =
  | typeof WASM_SANDBOX
  | typeof SES_SANDBOX
  | typeof CONFIDENTIAL_COMPUTE_SANDBOX;

export type SpecTree = {
  history: Message[];
  steps: {
    description: string;
    associatedNodes: NodeId[];
  }[];
};

export type NodeId = string;

export type Recipe = {
  spec: SpecTree;
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
  body: any;
  evalMode?: EvalMode;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
};
