import { isObj } from "@commontools/utils";

export const ID: unique symbol = Symbol("ID, unique to the context");
export const ID_FIELD: unique symbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
);

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

export type OpaqueRef<T> =
  & OpaqueRefMethods<T>
  & (T extends Array<infer U> ? Array<OpaqueRef<U>>
    : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
    : T);

// Any OpaqueRef is also an Opaque, but can also have static values.
// Use Opaque<T> in APIs that get inputs from the developer and use OpaqueRef
// when data gets passed into what developers see (either recipe inputs or
// module outputs).
export type Opaque<T> =
  | OpaqueRef<T>
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

export type OpaqueRefMethods<T> = {
  get(): OpaqueRef<T>;
  set(value: Opaque<T> | T): void;
  key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
  setDefault(value: Opaque<T> | T): void;
  setPreExisting(ref: any): void;
  setName(name: string): void;
  connect(node: NodeRef): void;
  export(): {
    cell: OpaqueRef<any>;
    path: PropertyKey[];
    value?: Opaque<T>;
    defaultValue?: Opaque<T>;
    nodes: Set<NodeRef>;
    external?: any;
    name?: string;
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    frame: Frame;
  };
  unsafe_bindToRecipeAndPath(
    recipe: Recipe,
    path: PropertyKey[],
  ): void;
  unsafe_getExternal(): OpaqueRef<T>;
  map<S>(
    fn: (
      element: T extends Array<infer U> ? Opaque<U> : Opaque<T>,
      index: Opaque<number>,
      array: T,
    ) => Opaque<S>,
  ): Opaque<S[]>;
  toJSON(): any;
  [Symbol.iterator](): Iterator<T>;
  [Symbol.toPrimitive](hint: string): T;
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

export type NodeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & (Module | Handler | Recipe)
  & toJSON;

export type RecipeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Recipe
  & toJSON;

export type ModuleFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Module
  & toJSON;

export type HandlerFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Handler<T, R>
  & toJSON;

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONArray
  | JSONObject & IDFields;

export interface JSONArray extends ArrayLike<JSONValue> {}

export interface JSONObject extends Record<string, JSONValue> {}

// Annotations when writing data that help determine the entity id. They are
// removed before sending to storage.
export interface IDFields {
  [ID]?: any;
  [ID_FIELD]?: any;
}

// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
export type JSONSchema = {
  readonly [ID]?: any;
  readonly [ID_FIELD]?: any;
  readonly type?:
    | "object"
    | "array"
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "null";
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly description?: string;
  readonly default?: Readonly<JSONValue>;
  readonly title?: string;
  readonly example?: Readonly<JSONValue>;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly items?: Readonly<JSONSchema>;
  readonly $ref?: string;
  readonly asCell?: boolean;
  readonly asStream?: boolean;
  readonly anyOf?: readonly JSONSchema[];
  readonly additionalProperties?: Readonly<JSONSchema> | boolean;
  readonly ifc?: { classification?: string[]; integrity?: string[] }; // temporarily used to assign labels like "confidential"
};

export type Writable<T> = {
  -readonly [P in keyof T]: T[P] extends ReadonlyArray<infer U> ? Writable<U>[]
    : T[P] extends Readonly<infer U> ? Writable<U>
    : T[P];
};

export type JSONSchemaWritable = Writable<JSONSchema>;

export type Alias = {
  $alias: {
    cell?: any;
    path: PropertyKey[];
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
  };
};

export function isAlias(value: any): value is Alias {
  return isObj(value) && isObj(value.$alias) &&
    Array.isArray(value.$alias.path);
}

export type StreamAlias = {
  $stream: true;
};

export function isStreamAlias(value: any): value is StreamAlias {
  return !!value && typeof value.$stream === "boolean" && value.$stream;
}

export type Module = {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
  implementation?: ((...args: any[]) => any) | Recipe | string;
  wrapper?: "handler";
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
};

export type Handler<T = any, R = any> = Module & {
  with: (inputs: Opaque<T>) => OpaqueRef<R>;
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
  inputs: JSONValue;
  outputs: JSONValue;
};

// Used to get back to original recipe from a JSONified representation.
export const unsafe_originalRecipe = Symbol("unsafe_originalRecipe");
export const unsafe_parentRecipe = Symbol("unsafe_parentRecipe");
export const unsafe_materializeFactory = Symbol("unsafe_materializeFactory");

export type Recipe = {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  initial?: JSONValue;
  result: JSONValue;
  nodes: Node[];
  [unsafe_originalRecipe]?: Recipe;
  [unsafe_parentRecipe]?: Recipe;
  [unsafe_materializeFactory]?: (log: any) => (path: PropertyKey[]) => any;
};

export function isRecipe(value: any): value is Recipe {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    !!value.argumentSchema &&
    !!value.resultSchema &&
    !!value.nodes &&
    Array.isArray(value.nodes)
  );
}

type CanBeOpaqueRef = { [toOpaqueRef]: () => OpaqueRef<any> };

export function canBeOpaqueRef(value: any): value is CanBeOpaqueRef {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
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

export type UnsafeBinding = {
  recipe: Recipe;
  materialize: (path: PropertyKey[]) => any;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: any;
  generatedIdCounter: number;
  opaqueRefs: Set<OpaqueRef<any>>;
  unsafe_binding?: UnsafeBinding;
};

const isStaticMarker = Symbol("isStatic");

export type Static = {
  [isStaticMarker]: true;
};

export function isStatic(value: any): value is Static {
  return typeof value === "object" && value !== null &&
    value[isStaticMarker] === true;
}

export function markAsStatic(value: any): any {
  value[isStaticMarker] = true;
  return value;
}
