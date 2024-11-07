import { JavaScriptModuleDefinition } from "@commontools/common-runtime";

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

export type OpaqueRef<T> = OpaqueRefMethods<T> &
  (T extends Array<infer U>
    ? Array<OpaqueRef<U>>
    : T extends object
      ? { [K in keyof T]: OpaqueRef<T[K]> }
      : T);

// Any OpaqueRef is also an Opaque, but can also have static values.
// Use Opaque<T> in APIs that get inputs from the developer and use OpaqueRef
// when data gets passed into what developers see (either recipe inputs or
// module outputs).
export type Opaque<T> =
  | OpaqueRef<T>
  | (T extends Array<infer U>
      ? Array<Opaque<U>>
      : T extends object
        ? { [K in keyof T]: Opaque<T[K]> }
        : T);

export type OpaqueRefMethods<T> = {
  get(): OpaqueRef<T>;
  set(value: Opaque<T> | T): void;
  key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
  setDefault(value: Opaque<T> | T): void;
  setPreExisting(ref: any): void;
  connect(node: NodeRef): void;
  export(): {
    cell: OpaqueRef<any>;
    path: PropertyKey[];
    value?: Opaque<T>;
    defaultValue?: Opaque<T>;
    nodes: Set<NodeRef>;
    external?: any;
    frame: Frame;
  };
  map<S>(
    fn: (value: T extends Array<infer U> ? Opaque<U> : Opaque<T>) => Opaque<S>,
  ): Opaque<S[]>;
  [Symbol.iterator](): Iterator<T>;
  [isOpaqueRefMarker]: true;
};

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueRef(value: any): value is OpaqueRef<any> {
  return value && typeof value[isOpaqueRefMarker] === "boolean";
}

export type NodeRef = {
  module: Module | Recipe | OpaqueRef<Module | Recipe>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

export type toJSON = {
  toJSON(): any;
};

export type NodeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) &
  (Module | Recipe) &
  toJSON;

export type RecipeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) &
  Recipe &
  toJSON;

export type ModuleFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) &
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
  argumentSchema?: JSON;
  resultSchema?: JSON;
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
  argumentSchema: JSON;
  resultSchema: JSON;
  initial?: JSON;
  result: JSON;
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

type CanBeOpaqueRef = { [toOpaqueRef]: () => OpaqueRef<any> };

export function canBeOpaqueRef(value: any): value is CanBeOpaqueRef {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value[toOpaqueRef] === "function"
  );
}

export function makeOpaqueRef(value: CanBeOpaqueRef): OpaqueRef<any> {
  return value[toOpaqueRef]();
}

export const toOpaqueRef = Symbol("toOpaqueRef");

export type ShadowRef = {
  shadowOf: OpaqueRef<any> | ShadowRef;
};

export function isShadowRef(value: any): value is ShadowRef {
  return (
    !!value &&
    typeof value === "object" &&
    "shadowOf" in value &&
    (isOpaqueRef(value.shadowOf) || isShadowRef(value.shadowOf))
  );
}

export type Frame = {
  parent?: Frame;
  cause?: any;
};

const isStaticMarker = Symbol("isStatic");

export type Static = {
  [isStaticMarker]: true;
};

export function isStatic(value: any): value is Static {
  return (
    typeof value === "object" &&
    value !== null &&
    value[isStaticMarker] === true
  );
}

export function markAsStatic(value: any): any {
  value[isStaticMarker] = true;
  return value;
}
