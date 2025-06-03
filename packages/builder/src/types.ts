import { isObject, Mutable } from "@commontools/utils/types";

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
  setPreExisting(ref: unknown): void;
  setName(name: string): void;
  setSchema(schema: JSONSchema): void;
  connect(node: NodeRef): void;
  export(): {
    cell: OpaqueRef<any>;
    path: PropertyKey[];
    value?: Opaque<T>;
    defaultValue?: Opaque<T>;
    nodes: Set<NodeRef>;
    external?: unknown;
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
  toJSON(): unknown;
  [Symbol.iterator](): Iterator<T>;
  [Symbol.toPrimitive](hint: string): T;
  [isOpaqueRefMarker]: true;
};

export const isOpaqueRefMarker = Symbol("isOpaqueRef");

export function isOpaqueRef(value: unknown): value is OpaqueRef<any> {
  return !!value && typeof (value as any)[isOpaqueRefMarker] === "boolean";
}

export type NodeRef = {
  module: Module | Recipe | OpaqueRef<Module | Recipe>;
  inputs: Opaque<any>;
  outputs: OpaqueRef<any>;
  frame: Frame | undefined;
};

export type toJSON = {
  toJSON(): unknown;
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
  [ID]?: unknown;
  [ID_FIELD]?: unknown;
}

// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
export type JSONSchema = {
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
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
  readonly $defs?: Readonly<Record<string, JSONSchema>>;
  readonly asCell?: boolean;
  readonly asStream?: boolean;
  readonly anyOf?: readonly JSONSchema[];
  readonly additionalProperties?: Readonly<JSONSchema> | boolean;
  readonly ifc?: { classification?: string[]; integrity?: string[] }; // temporarily used to assign labels like "confidential"
};

export { type Mutable };
export type JSONSchemaMutable = Mutable<JSONSchema>;

export type Alias = {
  $alias: {
    cell?: unknown;
    path: PropertyKey[];
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
  };
};

export function isAlias(value: unknown): value is Alias {
  return isObject(value) && "$alias" in value && isObject(value.$alias) &&
    "path" in value.$alias &&
    Array.isArray(value.$alias.path);
}

export type StreamAlias = {
  $stream: true;
};

export function isStreamAlias(value: unknown): value is StreamAlias {
  return !!value && typeof (value as any).$stream === "boolean" && (value as any).$stream;
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

export function isModule(value: unknown): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    typeof (value as any).type === "string"
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

export function isRecipe(value: unknown): value is Recipe {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    !!(value as any).argumentSchema &&
    !!(value as any).resultSchema &&
    !!(value as any).nodes &&
    Array.isArray((value as any).nodes)
  );
}

type CanBeOpaqueRef = { [toOpaqueRef]: () => OpaqueRef<any> };

export function canBeOpaqueRef(value: unknown): value is CanBeOpaqueRef {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as any)[toOpaqueRef] === "function"
  );
}

export function makeOpaqueRef(value: CanBeOpaqueRef): OpaqueRef<any> {
  return value[toOpaqueRef]();
}

export const toOpaqueRef = Symbol("toOpaqueRef");

export type ShadowRef = {
  shadowOf: OpaqueRef<any> | ShadowRef;
};

export function isShadowRef(value: unknown): value is ShadowRef {
  return (
    !!value &&
    typeof value === "object" &&
    "shadowOf" in value &&
    (isOpaqueRef((value as any).shadowOf) || isShadowRef((value as any).shadowOf))
  );
}

export type UnsafeBinding = {
  recipe: Recipe;
  materialize: (path: PropertyKey[]) => any;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  opaqueRefs: Set<OpaqueRef<any>>;
  unsafe_binding?: UnsafeBinding;
};

const isStaticMarker = Symbol("isStatic");

export type Static = {
  [isStaticMarker]: true;
};

export function isStatic(value: unknown): value is Static {
  return typeof value === "object" && value !== null &&
    (value as any)[isStaticMarker] === true;
}

export function markAsStatic(value: unknown): unknown {
  (value as any)[isStaticMarker] = true;
  return value;
}
