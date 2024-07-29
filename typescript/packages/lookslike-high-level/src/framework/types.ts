export type Value<T> =
  | (T extends string | number | boolean | null | undefined
      ? T
      : T extends readonly [...any[]]
      ? { [K in keyof T]: Value<T[K]> }
      : T extends Array<infer U>
      ? Array<Value<U>>
      : T extends object
      ? { [K in keyof T]: Value<T[K]> }
      : never)
  | CellProxy<T>;

export type CellProxy<T> = CellProxyMethods<T> & {
  [K in keyof T]: CellProxy<T[K]>;
};

export type CellProxyMethods<T> = {
  get(): CellProxy<T>;
  set(value: Value<T>): void;
  setDefault(value: Value<T>): void;
  connect(node: NodeProxy): void;
  [getCellForRecipe](): {
    path: PropertyKey[];
    value?: Value<T>;
    defaultValue?: Value<T>;
    nodes: Set<NodeProxy>;
  };
};

export function isCell(value: any): value is CellProxy<any> {
  return value && typeof value[getCellForRecipe] === "function";
}

export type NodeProxy = {
  module: Module | Recipe | CellProxy<Module | Recipe>;
  inputs: Value<any>;
  outputs: CellProxy<any>;
};

export type NodeFactory<T, R> = ((inputs: Value<T>) => Value<R>) &
  (Module | Recipe);

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JSON = JSONValue | { [key: string]: JSONValue };

export type Reference = {
  $ref: PropertyKey[] | [[], ...any];
};

export function isReference(value: any): value is Reference {
  return !!(value && value.$ref && Array.isArray(value.$ref));
}

export type Module = {
  type: "javascript" | "recipe" | "value";
  implementation?: Function | Recipe | JSON;
};

export function isModule(value: any): value is Module {
  return !!(value && value.implementation);
}

export type Node = {
  description?: string;
  module: Module | Recipe | Reference;
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

export const getCellForRecipe = Symbol("getCellForRecipe");
