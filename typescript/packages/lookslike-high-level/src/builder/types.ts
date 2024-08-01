export type Value<T> =
  | (T extends string | number | boolean | null | undefined
      ? CellProxy<T>
      : T extends readonly [...any[]]
      ? { [K in keyof T]: Value<T[K]> }
      : T extends Array<infer U>
      ? Array<Value<U>>
      : T extends object
      ? { [K in keyof T]: Value<T[K]> }
      : never)
  | CellProxy<T>;

export type CellProxy<T> = CellProxyMethods<T> &
  (T extends object
    ? {
        [K in keyof T]: CellProxy<T[K]>;
      }
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

export type NodeFactory<T, R> = ((inputs: Value<T>) => Value<R>) &
  (Module | Recipe) &
  toJSON;

export type RecipeFactory<T, R> = ((inputs: Value<T>) => Value<R>) &
  Recipe &
  toJSON;

export type ModuleFactory<T, R> = ((inputs: Value<T>) => Value<R>) &
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

export type Module = {
  type: "javascript" | "recipe" | "passthrough";
  implementation?: Function | Recipe;
};

export function isModule(value: any): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    (value.type === "javascript" ||
      value.type === "recipe" ||
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
