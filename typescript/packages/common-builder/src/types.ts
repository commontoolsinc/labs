// Should be Symbol("ID") or so, but this makes repeat() use these when
// iterating over recipes.
export const ID = "$ID";
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
  setDefault(value: Value<T> | T): void;
  connect(node: NodeProxy): void;
  export(): {
    top: CellProxy<any>;
    path: PropertyKey[];
    value?: Value<T>;
    defaultValue?: Value<T>;
    nodes: Set<NodeProxy>;
  };
  map<S>(
    fn: (value: T extends Array<infer U> ? Value<U> : Value<T>) => Value<S>
  ): Value<S[]>;
  [isCellProxyMarker]: true;
};

export function isCell(value: any): value is CellProxy<any> {
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
  type: "javascript" | "recipe" | "builtin" | "passthrough";
  implementation?: Function | Recipe | string;
  wrapper?: "handler";
};

export function isModule(value: any): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    (value.type === "javascript" ||
      value.type === "recipe" ||
      value.type === "builtin" ||
      value.type === "passthrough")
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
  return !!(value && value.schema && value.nodes && Array.isArray(value.nodes));
}

export const isCellProxyMarker = Symbol("isCellProxy");
