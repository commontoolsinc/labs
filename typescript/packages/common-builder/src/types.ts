import { JavaScriptModuleDefinition } from "@commontools/common-runtime";

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

export type CellProxy<T> = CellProxyMethods<T> &
  (T extends Array<infer U>
    ? Array<CellProxy<U>>
    : T extends object
    ? { [K in keyof T]: CellProxy<T[K]> }
    : T);

// Any CellProxy is also a Value, but a Value can have static values as well.
// Use Value<T> in APIs that get inputs from the developer and use CellProxy
// when data gets passed into what developers see (either recipe inputs or
// module outputs).
export type Value<T> =
  | CellProxy<T>
  | (T extends Array<infer U>
      ? Array<Value<U>>
      : T extends object
      ? { [K in keyof T]: Value<T[K]> }
      : T);

export type CellProxyMethods<T> = {
  get(): CellProxy<T>;
  set(value: Value<T> | T): void;
  key<K extends keyof T>(key: K): CellProxy<T[K]>;
  setDefault(value: Value<T> | T): void;
  setPreExisting(ref: any): void;
  connect(node: NodeProxy): void;
  export(): {
    cell: CellProxy<any>;
    path: PropertyKey[];
    value?: Value<T>;
    defaultValue?: Value<T>;
    nodes: Set<NodeProxy>;
    external?: any;
  };
  map<S>(
    fn: (value: T extends Array<infer U> ? Value<U> : Value<T>) => Value<S>
  ): Value<S[]>;
  [isCellProxyMarker]: true;
};

export const isCellProxyMarker = Symbol("isCellProxy");

export function isCellProxy(value: any): value is CellProxy<any> {
  return value && typeof value[isCellProxyMarker] === "boolean";
}

export type NodeProxy = {
  module: Module | Recipe | CellProxy<Module | Recipe>;
  inputs: Value<any>;
  outputs: CellProxy<any>;
};

export type toJSON = {
  toJSON(): any;
};

export type NodeFactory<T, R> = ((inputs: Value<T>) => CellProxy<R>) &
  (Module | Recipe) &
  toJSON;

export type RecipeFactory<T, R> = ((inputs: Value<T>) => CellProxy<R>) &
  Recipe &
  toJSON;

export type ModuleFactory<T, R> = ((inputs: Value<T>) => CellProxy<R>) &
  Module &
  toJSON;

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JSON = JSONValue | { [key: string]: JSONValue };

export type Alias = {
  $alias: { cell?: any; path: PropertyKey[] };
};

export function isAlias(value: any): value is Alias {
  return !!(value && value.$alias && Array.isArray(value.$alias.path));
}

export type StreamAlias = {
  $stream: true;
};

export function isStreamAlias(value: any): value is StreamAlias {
  return !!value && typeof value.$stream === "boolean" && value.$stream;
}

export type Module = {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
  implementation?: Function | Recipe | JavaScriptModuleDefinition | string;
  wrapper?: "handler";
};

export function isModule(value: any): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    typeof value.type === "string"
  );
}

export type Node = {
  description?: string;
  module: Module | Alias;
  inputs: JSON;
  outputs: JSON;
};

export type Recipe = {
  schema: JSON;
  initial: JSON;
  nodes: Node[];
};

export function isRecipe(value: any): value is Recipe {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    !!value.schema &&
    !!value.nodes &&
    Array.isArray(value.nodes)
  );
}

type CanBeCellProxy = { [toCellProxy]: () => CellProxy<any> };

export function canBeCellProxy(value: any): value is CanBeCellProxy {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value[toCellProxy] === "function"
  );
}

export function makeCellProxy(value: CanBeCellProxy): CellProxy<any> {
  return value[toCellProxy]();
}

export const toCellProxy = Symbol("toCellProxy");

export type Frame = {
  parent?: Frame;
};
