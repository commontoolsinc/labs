/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public recipe API.
 *
 * Workspace code should import these types via `@commontools/builder`.
 */

export const ID: unique symbol = Symbol("ID, unique to the context");
export const ID_FIELD: unique symbol = Symbol(
  "ID_FIELD, name of sibling that contains id",
);

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";

// ============================================================================
// Cell Brand System
// ============================================================================

/**
 * Brand symbol for identifying different cell types at compile-time.
 * Each cell variant has a unique combination of capability flags.
 */
export declare const CELL_BRAND: unique symbol;

/**
 * Brand value indicating cell capabilities.
 * - opaque: Cell reference is opaque (not directly readable/writable)
 * - read: Has .get() method
 * - write: Has .set() method
 * - stream: Has .send() method
 * - comparable: Has .equals() method (available on comparable and readable cells)
 */
export type CellBrand = {
  opaque: boolean;
  read: boolean;
  write: boolean;
  stream: boolean;
  comparable: boolean;
};

/**
 * Base type for all cell variants. Uses a symbol brand to distinguish
 * different cell types at compile-time while sharing common structure.
 */
export type AnyCell<T = any, Brand extends CellBrand = CellBrand> = {
  [CELL_BRAND]: Brand;
} & CellMethods<T, Brand>;

// ============================================================================
// Cell Capability Interfaces
// ============================================================================

/**
 * Readable cells can retrieve their current value.
 */
export interface Readable<T> {
  get(): Readonly<T>;
}

/**
 * Writable cells can update their value.
 */
export interface Writable<T> {
  set(value: T): void;
  update(values: Partial<T>): void;
  push(...value: T extends (infer U)[] ? U[] : never): void;
}

/**
 * Streamable cells can send events.
 */
export interface Streamable<T> {
  send(event: T): void;
}

/**
 * Cells that support key() for property access.
 * Available on all cells except streams.
 */
export interface Keyable<T, Brand extends CellBrand = CellBrand> {
  key<K extends keyof T>(valueKey: K): AnyCell<T[K], Brand>;
}

/**
 * Cells that can be resolved back to a Cell.
 * Only available on full Cell<T>, not on OpaqueCell or Stream.
 */
export interface Resolvable<T, Brand extends CellBrand = CellBrand> {
  resolveAsCell(): AnyCell<T, Brand>;
}

/**
 * Comparable cells have equals() method.
 * Available on comparable and readable cells.
 */
export interface Equatable {
  equals(other: AnyCell<any>): boolean;
}

/**
 * Derivable cells support functional transformations.
 * This is a placeholder - the actual methods are defined below after OpaqueRef.
 */
export interface Derivable<T> {
  // Methods defined below after OpaqueRef is available
}

/**
 * Combines cell capabilities based on brand flags.
 * - All cells get Keyable (.key) except streams
 * - Full cells (read + write) get Resolvable (.resolveAsCell)
 * - Comparable and readable cells get Equatable (.equals)
 * - Each flag enables its corresponding capability
 */
type CellMethods<T, Brand extends CellBrand> =
  & (Brand["stream"] extends true ? Record<never, never> : Keyable<T, Brand>)
  & (Brand["read"] extends true
    ? Brand["write"] extends true
      ? Readable<T> & Equatable & Resolvable<T, Brand>
    : Readable<T> & Equatable
    : Record<never, never>)
  & (Brand["comparable"] extends true ? Equatable : Record<never, never>)
  & (Brand["write"] extends true ? Writable<T> : Record<never, never>)
  & (Brand["stream"] extends true ? Streamable<T> : Record<never, never>)
  & (Brand["opaque"] extends true ? Derivable<T> : Record<never, never>);

// ============================================================================
// Cell Type Definitions
// ============================================================================

/**
 * Opaque cell reference - only supports keying and derivation, not direct I/O.
 * Has .key(), .map(), .mapWithPattern()
 * Does NOT have .get()/.set()/.send()/.equals()/.resolveAsCell()
 * Brand: { opaque: true, read: false, write: false, stream: false, comparable: false }
 */
export type OpaqueCell<T = any> = AnyCell<
  T,
  { opaque: true; read: false; write: false; stream: false; comparable: false }
>;

/**
 * Full cell with read, write, and stream capabilities.
 * Has .get(), .set(), .send(), .update(), .push(), .equals(), .key(), .resolveAsCell()
 * Brand: { opaque: false, read: true, write: true, stream: true, comparable: false }
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 * Note: comparable is false because .equals() comes from read: true, not comparable: true
 */
export interface Cell<T = any> extends
  AnyCell<
    T,
    { opaque: false; read: true; write: true; stream: true; comparable: false }
  > {}

/**
 * Stream-only cell - can only send events, not read or write.
 * Has .send() only
 * Does NOT have .key()/.equals()/.get()/.set()/.resolveAsCell()
 * Brand: { opaque: false, read: false, write: false, stream: true, comparable: false }
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface Stream<T> extends
  AnyCell<
    T,
    {
      opaque: false;
      read: false;
      write: false;
      stream: true;
      comparable: false;
    }
  > {}

/**
 * Comparable-only cell - just for equality checks and keying.
 * Has .equals(), .key()
 * Does NOT have .resolveAsCell()/.get()/.set()/.send()
 * Brand: { opaque: false, read: false, write: false, stream: false, comparable: true }
 */
export type ComparableCell<T = any> = AnyCell<
  T,
  { opaque: false; read: false; write: false; stream: false; comparable: true }
>;

/**
 * Read-only cell variant.
 * Has .get(), .equals(), .key()
 * Does NOT have .resolveAsCell()/.set()/.send()
 * Brand: { opaque: false, read: true, write: false, stream: false, comparable: false }
 */
export type ReadonlyCell<T = any> = AnyCell<
  T,
  { opaque: false; read: true; write: false; stream: false; comparable: true }
>;

/**
 * Write-only cell variant.
 * Has .set(), .update(), .push(), .key()
 * Does NOT have .resolveAsCell()/.get()/.equals()/.send()
 * Brand: { opaque: false, read: false, write: true, stream: false, comparable: false }
 */
export type WriteonlyCell<T = any> = AnyCell<
  T,
  { opaque: false; read: false; write: true; stream: false; comparable: false }
>;

// ============================================================================
// OpaqueRef - Proxy-based variant of OpaqueCell
// ============================================================================

/**
 * Methods available on OpaqueRef beyond what OpaqueCell provides.
 * This interface can be augmented by the runtime to add internal methods
 * like .export(), .setDefault(), .setName(), .setSchema(), .connect(), etc.
 *
 * Note: .key() is overridden here to return OpaqueRef instead of OpaqueCell,
 * maintaining the OpaqueRef type through property access.
 */
export interface OpaqueRefMethods<T> {
  get(): T;
  set(value: CellLike<T> | T): void;
  key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
}

/**
 * OpaqueRef is a variant of OpaqueCell with recursive proxy behavior.
 * Each key access returns another OpaqueRef, allowing chained property access.
 * This is temporary until AST transformation handles .key() automatically.
 *
 * OpaqueRef extends OpaqueCell with OpaqueRefMethods (which can be augmented by runtime).
 * We omit methods from OpaqueCell that are redefined in OpaqueRefMethods to ensure
 * the OpaqueRefMethods versions take precedence (e.g., .key() returning OpaqueRef).
 */
export type OpaqueRef<T> =
  & Omit<OpaqueCell<T>, keyof OpaqueRefMethods<any>>
  & OpaqueRefMethods<T>
  & (T extends Array<infer U> ? Array<OpaqueRef<U>>
    : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
    : T);

// ============================================================================
// CellLike and Opaque - Utility types for accepting cells
// ============================================================================

/**
 * CellLike is a cell (AnyCell) whose nested values are Opaque.
 * The top level must be AnyCell, but nested values can be plain or wrapped.
 *
 * Note: This is primarily used for type constraints that require a cell.
 */
export type CellLike<T> = AnyCell<T>;

/**
 * Opaque accepts T or any cell wrapping T, recursively at any nesting level.
 * Used in APIs that accept inputs from developers - can be static values
 * or wrapped in cells (OpaqueRef, Cell, etc).
 *
 * Conceptually: T | AnyCell<T> at any nesting level, but we use OpaqueRef
 * for backward compatibility since it has the recursive proxy behavior that
 * allows property access (e.g., Opaque<{foo: string}> includes {foo: Opaque<string>}).
 */
export type Opaque<T> =
  | OpaqueRef<T>
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

/**
 * Cellify is a type utility that allows any part of type T to be wrapped in
 * AnyCell<>, and allow any part of T that is currently wrapped in AnyCell<> to be
 * used unwrapped. This is designed for use with cell method parameters,
 * allowing flexibility in how values are passed.
 *
 * Note: Does NOT include ID/ID_FIELD symbols - use CellifyForWrite for write
 * operations that need those metadata fields.
 */
export type Cellify<T> =
  // Handle existing AnyCell<> types, allowing unwrapping
  T extends AnyCell<infer U> ? Cellify<U> | AnyCell<Cellify<U>>
    // Handle arrays
    : T extends Array<infer U> ? Array<Cellify<U>> | AnyCell<Array<Cellify<U>>>
    // Handle objects (excluding null)
    : T extends object ?
        | { [K in keyof T]: Cellify<T[K]> }
        | AnyCell<{ [K in keyof T]: Cellify<T[K]> }>
    // Handle primitives
    : T | AnyCell<T>;

/**
 * CellifyForWrite is used for write operations (.set(), .push(), .update()).
 * Currently identical to Cellify. The ID and ID_FIELD metadata symbols are
 * added at runtime via recursivelyAddIDIfNeeded, not enforced by the type system.
 */
export type CellifyForWrite<T> = Cellify<T>;

// ============================================================================
// Extend Derivable interface now that OpaqueRef and Opaque are defined
// ============================================================================

// Interface merging to add methods to Derivable
export interface Derivable<T> {
  map<S>(
    fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => Opaque<S>,
  ): OpaqueRef<S[]>;
  mapWithPattern<S>(
    op: Recipe,
    params: Record<string, any>,
  ): OpaqueRef<S[]>;
}

// Factory types

// TODO(seefeld): Subset of internal type, just enough to make it
// differentiated. But this isn't part of the public API, so we need to find a
// different way to handle this.
export interface Recipe {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}
export interface Module {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
}

export type toJSON = {
  toJSON(): unknown;
};

export type Handler<T = any, R = any> = Module & {
  with: (inputs: Opaque<StripCell<T>>) => OpaqueRef<R>;
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
  & ((inputs: Opaque<StripCell<T>>) => OpaqueRef<R>)
  & Handler<T, R>
  & toJSON;

// JSON types

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

// Valid values for the "type" property of a JSONSchema
export type JSONSchemaTypes =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null";

// See https://json-schema.org/draft/2020-12/json-schema-core
// See https://json-schema.org/draft/2020-12/json-schema-validation
// There is a lot of potential validation that is not handled, but this object
// is defined to support them, so that generated schemas will still be usable.
// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
export type JSONSchema = JSONSchemaObj | boolean;

export type JSONSchemaObj = {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JSONSchema>>;
  /** @deprecated Use `$defs` for 2019-09/Draft 8 or later */
  readonly definitions?: Readonly<Record<string, JSONSchema>>;

  // Subschema logic
  readonly allOf?: readonly (JSONSchema)[]; // not validated
  readonly anyOf?: readonly (JSONSchema)[]; // not always validated
  readonly oneOf?: readonly (JSONSchema)[]; // not always validated
  readonly not?: JSONSchema;
  // Subschema conditionally - none applied
  readonly if?: JSONSchema;
  readonly then?: JSONSchema;
  readonly else?: JSONSchema;
  readonly dependentSchemas?: Readonly<Record<string, JSONSchema>>;
  // Subschema for array
  readonly prefixItems?: readonly (JSONSchema)[]; // not always validated
  readonly items?: Readonly<JSONSchema>;
  readonly contains?: JSONSchema; // not validated
  // Subschema for object
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly patternProperties?: Readonly<Record<string, JSONSchema>>; // not validated
  readonly additionalProperties?: JSONSchema;
  readonly propertyNames?: JSONSchema; // not validated

  // Validation for any
  readonly type?: JSONSchemaTypes | readonly JSONSchemaTypes[];
  readonly enum?: readonly Readonly<JSONValue>[]; // not validated
  readonly const?: Readonly<JSONValue>; // not validated
  // Validation for numeric - none applied
  readonly multipleOf?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  // Validation for string - none applied
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  // Validation for array  - none applied
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxContains?: number;
  readonly minContains?: number;
  // Validation for object
  readonly maxProperties?: number; // not validated
  readonly minProperties?: number; // not validated
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>; // not validated

  // Format annotations
  readonly format?: string; // not validated

  // Contents - none applied
  readonly contentEncoding?: string;
  readonly contentMediaType?: string;
  readonly contentSchema?: JSONSchema;

  // Meta-Data
  readonly title?: string;
  readonly description?: string;
  readonly default?: Readonly<JSONValue>;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly Readonly<JSONValue>[];
  readonly $schema?: string;
  readonly $comment?: string;

  // Common Tools extensions
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
  // makes it so that your handler gets a Cell object for that property. So you can call .set()/.update()/.push()/etc on it.
  readonly asCell?: boolean;
  // streams are what handler returns. if you pass that to another handler/lift and declare it as asSteam, you can call .send on it
  readonly asStream?: boolean;
  // temporarily used to assign labels like "confidential"
  readonly ifc?: { classification?: string[]; integrity?: string[] };
};

// LLM types matching Vercel AI SDK structure
export type BuiltInLLMTextPart = {
  type: "text";
  text: string;
};

export type BuiltInLLMImagePart = {
  type: "image";
  image: string | Uint8Array | ArrayBuffer | URL;
};

export type BuiltInLLMToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, any>;
};

export type BuiltInLLMToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "json"; value: any };
};

export type BuiltInLLMContentPart =
  | BuiltInLLMTextPart
  | BuiltInLLMImagePart
  | BuiltInLLMToolCallPart
  | BuiltInLLMToolResultPart;

export type BuiltInLLMContent = string | BuiltInLLMContentPart[];

export type BuiltInLLMMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: BuiltInLLMContent;
};

export type BuiltInLLMTool =
  & { description?: string }
  & (
    | { pattern: Recipe; handler?: never }
    | { handler: Stream<any> | OpaqueRef<any>; pattern?: never }
  );

// Built-in types
export interface BuiltInLLMParams {
  messages?: BuiltInLLMMessage[];
  model?: string;
  system?: string;
  stop?: string;
  maxTokens?: number;
  /**
   * Specifies the mode of operation for the LLM.
   * - `"json"`: Indicates that the LLM should process and return data in JSON format.
   * This parameter is optional and defaults to undefined, which may result in standard behavior.
   */
  mode?: "json";
  /**
   * Tools that can be called by the LLM during generation.
   * Each tool has a description, input schema, and handler function that runs client-side.
   */
  tools?: Record<string, BuiltInLLMTool>;
}

export interface BuiltInLLMState {
  pending: boolean;
  result?: BuiltInLLMContent;
  partial?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMGenerateObjectState<T> {
  pending: boolean;
  result?: T;
  partial?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMDialogState {
  pending: boolean;
  error: unknown;
  cancelGeneration: Stream<void>;
  addMessage: Stream<BuiltInLLMMessage>;
  flattenedTools: Record<string, any>;
}

export interface BuiltInGenerateObjectParams {
  model?: string;
  prompt?: string;
  schema?: JSONSchema;
  system?: string;
  cache?: boolean;
  maxTokens?: number;
  metadata?: Record<string, string | undefined | object>;
}

export interface BuiltInCompileAndRunParams<T> {
  files: Array<{ name: string; contents: string }>;
  main: string;
  input?: T;
}

export interface BuiltInCompileAndRunState<T> {
  pending: boolean;
  result?: T;
  error?: any;
  errors?: Array<{
    line: number;
    column: number;
    message: string;
    type: string;
    file?: string;
  }>;
}

// Function type definitions
export type RecipeFunction = {
  <S extends JSONSchema>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => any,
  ): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;

  <S extends JSONSchema, R>(
    argumentSchema: S,
    fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => Opaque<R>,
  ): RecipeFactory<SchemaWithoutCell<S>, R>;

  <S extends JSONSchema, RS extends JSONSchema>(
    argumentSchema: S,
    resultSchema: RS,
    fn: (
      input: OpaqueRef<Required<SchemaWithoutCell<S>>>,
    ) => Opaque<SchemaWithoutCell<RS>>,
  ): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;

  <T>(
    argumentSchema: string | JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => any,
  ): RecipeFactory<T, ReturnType<typeof fn>>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): RecipeFactory<T, R>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    resultSchema: JSONSchema,
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): RecipeFactory<T, R>;
};

export type PatternToolFunction = <
  T,
  E extends Partial<T> = Record<PropertyKey, never>,
>(
  fnOrRecipe: ((input: OpaqueRef<Required<T>>) => any) | RecipeFactory<T, any>,
  extraParams?: Opaque<E>,
) => OpaqueRef<Omit<T, keyof E>>;

export type LiftFunction = {
  <T extends JSONSchema = JSONSchema, R extends JSONSchema = JSONSchema>(
    argumentSchema: T,
    resultSchema: R,
    implementation: (input: Schema<T>) => Schema<R>,
  ): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;

  <T, R>(
    implementation: (input: T) => R,
  ): ModuleFactory<T, R>;

  <T>(
    implementation: (input: T) => any,
  ): ModuleFactory<T, ReturnType<typeof implementation>>;

  <T extends (...args: any[]) => any>(
    implementation: T,
  ): ModuleFactory<Parameters<T>[0], ReturnType<T>>;

  <T, R>(
    argumentSchema?: JSONSchema,
    resultSchema?: JSONSchema,
    implementation?: (input: T) => R,
  ): ModuleFactory<T, R>;
};

// Helper type to make non-Cell and non-Stream properties readonly in handler state
export type HandlerState<T> = T extends Cell<any> ? T
  : T extends Stream<any> ? T
  : T extends Array<infer U> ? ReadonlyArray<HandlerState<U>>
  : T extends object ? { readonly [K in keyof T]: HandlerState<T[K]> }
  : T;

export type HandlerFunction = {
  // With schemas

  <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(
    eventSchema: E,
    stateSchema: T,
    handler: (event: Schema<E>, props: Schema<T>) => any,
  ): ModuleFactory<StripCell<SchemaWithoutCell<T>>, SchemaWithoutCell<E>>;

  // With inferred types
  <E, T>(
    eventSchema: JSONSchema,
    stateSchema: JSONSchema,
    handler: (event: E, props: HandlerState<T>) => any,
  ): ModuleFactory<StripCell<T>, E>;

  // Without schemas
  <E, T>(
    handler: (event: E, props: T) => any,
    options: { proxy: true },
  ): ModuleFactory<StripCell<T>, E>;

  <E, T>(
    handler: (event: E, props: HandlerState<T>) => any,
  ): ModuleFactory<StripCell<T>, E>;
};

export type DeriveFunction = {
  <
    InputSchema extends JSONSchema = JSONSchema,
    ResultSchema extends JSONSchema = JSONSchema,
  >(
    argumentSchema: InputSchema,
    resultSchema: ResultSchema,
    input: Opaque<SchemaWithoutCell<InputSchema>>,
    f: (
      input: Schema<InputSchema>,
    ) => Schema<ResultSchema>,
  ): OpaqueRef<SchemaWithoutCell<ResultSchema>>;

  <In, Out>(
    input: Opaque<In>,
    f: (input: In) => Out,
  ): OpaqueRef<Out>;
};

export type ComputeFunction = <T>(fn: () => T) => OpaqueRef<T>;

export type RenderFunction = <T>(fn: () => T) => OpaqueRef<T>;

export type StrFunction = (
  strings: TemplateStringsArray,
  ...values: any[]
) => OpaqueRef<string>;

export type IfElseFunction = <T = any, U = any, V = any>(
  condition: Opaque<T>,
  ifTrue: Opaque<U>,
  ifFalse: Opaque<V>,
) => OpaqueRef<U | V>;

export type LLMFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState>;

export type LLMDialogFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMDialogState>;

export type GenerateObjectFunction = <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

export type FetchOptions = {
  body?: JSONValue;
  headers?: Record<string, string>;
  cache?:
    | "default"
    | "no-store"
    | "reload"
    | "no-cache"
    | "force-cache"
    | "only-if-cached";
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
  redirect?: "follow" | "error" | "manual";
};
export type FetchDataFunction = <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: FetchOptions;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: any }>;

export type StreamDataFunction = <T>(
  params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => Opaque<{ pending: boolean; result: T; error: any }>;

export type CompileAndRunFunction = <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<string>;
export type WishFunction = {
  <T = unknown>(target: Opaque<string>): OpaqueRef<T | undefined>;
  <T = unknown>(
    target: Opaque<string>,
    defaultValue: Opaque<T>,
  ): OpaqueRef<T>;
};

export type CreateNodeFactoryFunction = <T = any, R = any>(
  moduleSpec: Module,
) => ModuleFactory<T, R>;

export type CreateCellFunction = {
  <T>(
    schema?: JSONSchema,
    name?: string,
    value?: T,
  ): Cell<T>;

  <S extends JSONSchema = JSONSchema>(
    schema: S,
    name?: string,
    value?: Schema<S>,
  ): Cell<Schema<S>>;
};

// Default type for specifying default values in type definitions
export type Default<T, V extends T = T> = T;

// Re-export opaque ref creators
export type CellFunction = <T>(value?: T, schema?: JSONSchema) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;

// Recipe environment types
export interface RecipeEnvironment {
  readonly apiUrl: URL;
}

export type GetRecipeEnvironmentFunction = () => RecipeEnvironment;

// Re-export all function types as values for destructuring imports
// These will be implemented by the factory
export declare const recipe: RecipeFunction;
export declare const patternTool: PatternToolFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const derive: DeriveFunction;
export declare const compute: ComputeFunction;
export declare const render: RenderFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const llm: LLMFunction;
export declare const llmDialog: LLMDialogFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const fetchData: FetchDataFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
export declare const wish: WishFunction;
export declare const createNodeFactory: CreateNodeFactoryFunction;
export declare const createCell: CreateCellFunction;
export declare const cell: CellFunction;
export declare const stream: StreamFunction;
export declare const byRef: ByRefFunction;
export declare const getRecipeEnvironment: GetRecipeEnvironmentFunction;

/**
 * Helper type to recursively remove `readonly` properties from type `T`.
 *
 * (Duplicated from @commontools/utils/types.ts, but we want to keep this
 * independent for now)
 */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;

export const schema = <T extends JSONSchema>(schema: T) => schema;

// toSchema is a compile-time transformer that converts TypeScript types to JSONSchema
// The actual implementation is done by the TypeScript transformer
export const toSchema = <T>(_options?: Partial<JSONSchema>): JSONSchema => {
  return {} as JSONSchema;
};

// Helper type to transform Cell<T> to Opaque<T> in handler inputs
export type StripCell<T> = T extends Cell<infer U> ? StripCell<U>
  : T extends Array<infer U> ? StripCell<U>[]
  : T extends object ? { [K in keyof T]: StripCell<T[K]> }
  : T;

export type WishKey = `/${string}` | `#${string}`;

// ===== JSON Pointer Path Resolution Utilities =====

/**
 * Split a JSON Pointer reference into path segments.
 *
 * Examples:
 * - "#" -> []
 * - "#/$defs/Address" -> ["$defs", "Address"]
 * - "#/properties/name" -> ["properties", "name"]
 *
 * Note: Does not handle JSON Pointer escaping (~0, ~1) at type level.
 * Refs with ~ in keys will not work correctly in TypeScript types.
 */
type SplitPath<S extends string> = S extends "#" ? []
  : S extends `#/${infer Rest}` ? SplitPathSegments<Rest>
  : never;

type SplitPathSegments<S extends string> = S extends
  `${infer First}/${infer Rest}` ? [First, ...SplitPathSegments<Rest>]
  : [S];

/**
 * Navigate through a schema following a path of keys.
 * Returns never if the path doesn't exist.
 */
type NavigatePath<
  Schema extends JSONSchema,
  Path extends readonly string[],
  Depth extends DepthLevel = 9,
> = Depth extends 0 ? unknown
  : Path extends readonly [
    infer First extends string,
    ...infer Rest extends string[],
  ]
    ? Schema extends Record<string, any>
      ? First extends keyof Schema
        ? NavigatePath<Schema[First], Rest, DecrementDepth<Depth>>
      : never
    : never
  : Schema;

/**
 * Resolve a $ref string to the target schema.
 *
 * Supports:
 * - "#" (self-reference to root)
 * - "#/path/to/def" (JSON Pointer within document)
 *
 * External refs (URLs) return any.
 */
type ResolveRef<
  RefString extends string,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefString extends "#" ? Root
  : RefString extends `#/${string}`
    ? SplitPath<RefString> extends infer Path extends readonly string[]
      ? NavigatePath<Root, Path, Depth>
    : never
  : any; // External ref

/**
 * Merge two schemas, with left side taking precedence.
 * Used to apply ref site siblings to resolved target schema.
 */
type MergeSchemas<
  Left extends JSONSchema,
  Right extends JSONSchema,
> = Left extends boolean ? Left
  : Right extends boolean ? Right extends true ? Left
    : false
  : {
    [K in keyof Left | keyof Right]: K extends keyof Left ? Left[K]
      : K extends keyof Right ? Right[K]
      : never;
  };

/**
 * Merge ref site schema with resolved target, then process with Schema<>.
 * Implements JSON Schema spec: ref site siblings override target.
 */
type MergeRefSiteWithTarget<
  RefSite extends JSONSchema,
  Target extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefSite extends { $ref: string }
  ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends
    infer Merged extends JSONSchema ? Schema<Merged, Root, Depth>
  : never
  : never;

/**
 * Merge ref site schema with resolved target, then process with SchemaWithoutCell<>.
 * Same as MergeRefSiteWithTarget but doesn't wrap in Cell/Stream.
 */
type MergeRefSiteWithTargetWithoutCell<
  RefSite extends JSONSchema,
  Target extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = RefSite extends { $ref: string }
  ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends
    infer Merged extends JSONSchema ? SchemaWithoutCell<Merged, Root, Depth>
  : never
  : never;

/**
 * Convert a JSON Schema to its TypeScript type equivalent.
 *
 * Supports:
 * - Primitive types (string, number, boolean, null)
 * - Objects with properties (required/optional)
 * - Arrays with items
 * - anyOf unions
 * - $ref resolution (including JSON Pointers)
 * - asCell/asStream reactive wrappers
 * - default values (makes properties required)
 *
 * $ref Support:
 * - "#" (self-reference to root schema)
 * - "#/$defs/Name" (JSON Pointer to definition)
 * - "#/properties/field" (JSON Pointer to any schema location)
 * - External refs (http://...) return type `any`
 *
 * Default Precedence:
 * When both ref site and target have `default`, ref site takes precedence
 * per JSON Schema 2020-12 specification.
 *
 * Limitations:
 * - JSON Pointer escaping (~0, ~1) not supported at type level
 * - Depth limited to 9 levels to prevent infinite recursion
 * - Complex allOf/oneOf logic may not match runtime exactly
 *
 * @template T - The JSON Schema to convert
 * @template Root - Root schema for $ref resolution
 * @template Depth - Recursion depth limit (0-9)
 */
export type Schema<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> =
  // If we're out of depth, short-circuit
  Depth extends 0 ? unknown
    // Handle asCell attribute - wrap the result in Cell<T>
    : T extends { asCell: true } ? Cell<Schema<Omit<T, "asCell">, Root, Depth>>
    // Handle asStream attribute - wrap the result in Stream<T>
    : T extends { asStream: true }
      ? Stream<Schema<Omit<T, "asStream">, Root, Depth>>
    // Handle $ref: "#" (self-reference) specially to preserve recursion
    : T extends { $ref: "#" }
      ? Schema<Omit<Root, "asCell" | "asStream">, Root, DecrementDepth<Depth>>
    // Handle $ref - resolve and merge with ref site schema
    : T extends { $ref: infer RefStr extends string } ? MergeRefSiteWithTarget<
        T,
        ResolveRef<RefStr, Root, DecrementDepth<Depth>>,
        Root,
        DecrementDepth<Depth>
      >
    // Handle enum values
    : T extends { enum: infer E extends readonly any[] } ? E[number]
    // Handle oneOf (not yet supported in schema.ts, so commenting out)
    // : T extends { oneOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema ?
    //         | Schema<F, Root, DecrementDepth<Depth>>
    //         | Schema<{ oneOf: R }, Root, Depth>
    //       : never
    //     : never
    // Handle anyOf
    : T extends { anyOf: infer U extends readonly JSONSchema[] }
      ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
        ? F extends JSONSchema ?
            | Schema<F, Root, DecrementDepth<Depth>>
            | Schema<{ anyOf: R }, Root, Depth>
        : never
      : never
    // Handle allOf (merge all types) (not yet supported in schema.ts, so commenting out)
    // : T extends { allOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema
    //       ? Schema<F, Root, Depth> & Schema<{ allOf: R }, Root, Depth>
    //     : never
    //   : Record<string | number | symbol, never>
    // Handle different primitive types
    : T extends { type: "string" } ? string
    : T extends { type: "number" | "integer" } ? number
    : T extends { type: "boolean" } ? boolean
    : T extends { type: "null" } ? null
    // Handle array type
    : T extends { type: "array" }
      ? T extends { items: infer I }
        ? I extends JSONSchema ? Array<Schema<I, Root, DecrementDepth<Depth>>>
        : unknown[]
      : unknown[] // No items specified, allow any items
    // Handle object type
    : T extends { type: "object" }
      ? T extends { properties: infer P }
        ? P extends Record<string, JSONSchema> ? ObjectFromProperties<
            P,
            T extends { required: readonly string[] } ? T["required"] : [],
            Root,
            Depth,
            T extends { additionalProperties: infer AP extends JSONSchema } ? AP
              : false,
            GetDefaultKeys<T>
          >
        : Record<string, unknown>
        // Object without properties - check additionalProperties
      : T extends { additionalProperties: infer AP }
        ? AP extends false ? Record<string | number | symbol, never> // Empty object
        : AP extends true ? Record<string | number | symbol, unknown>
        : AP extends JSONSchema ? Record<
            string | number | symbol,
            Schema<AP, Root, DecrementDepth<Depth>>
          >
        : Record<string | number | symbol, unknown>
        // Default for object with no properties and no additionalProperties specified
      : Record<string, unknown>
    // Default case
    : any;

// Get keys from the default object
type GetDefaultKeys<T extends JSONSchema> = T extends { default: infer D }
  ? D extends Record<string, any> ? keyof D & string
  : never
  : never;

// Helper type for building object types from properties
type ObjectFromProperties<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  AP extends JSONSchema = false,
  DK extends string = never,
> =
  // Required properties (either explicitly required or has a default value)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? K : never
        : never
    ]: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  // Optional properties (not required and no default)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? never : K
        : never
    ]?: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  // Additional properties
  & (
    AP extends false
      // Additional properties off => no-op instead of empty record
      ? Record<never, never>
      : AP extends true ? { [key: string]: unknown }
      : AP extends JSONSchema
        ? { [key: string]: Schema<AP, Root, DecrementDepth<Depth>> }
      : Record<string | number | symbol, never>
  )
  & IDFields;

// Restrict Depth to these numeric literal types
type DepthLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// Decrement map for recursion limit
type Decrement = {
  0: 0;
  1: 0;
  2: 1;
  3: 2;
  4: 3;
  5: 4;
  6: 5;
  7: 6;
  8: 7;
  9: 8;
};

// Helper function to safely get decremented depth
type DecrementDepth<D extends DepthLevel> = Decrement[D] & DepthLevel;

// Same as above, but ignoring asCell, so we never get cells. This is used for
// calls of lifted functions and handlers, since they can pass either cells or
// values.

export type SchemaWithoutCell<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> =
  // If we're out of depth, short-circuit
  Depth extends 0 ? unknown
    // Handle asCell attribute - but DON'T wrap in Cell, just use the inner type
    : T extends { asCell: true }
      ? SchemaWithoutCell<Omit<T, "asCell">, Root, Depth>
    // Handle asStream attribute - but DON'T wrap in Stream, just use the inner type
    : T extends { asStream: true }
      ? SchemaWithoutCell<Omit<T, "asStream">, Root, Depth>
    // Handle $ref: "#" (self-reference) specially to preserve recursion
    : T extends { $ref: "#" } ? SchemaWithoutCell<
        Omit<Root, "asCell" | "asStream">,
        Root,
        DecrementDepth<Depth>
      >
    // Handle $ref - resolve and merge with ref site schema
    : T extends { $ref: infer RefStr extends string }
      ? MergeRefSiteWithTargetWithoutCell<
        T,
        ResolveRef<RefStr, Root, DecrementDepth<Depth>>,
        Root,
        DecrementDepth<Depth>
      >
    // Handle enum values
    : T extends { enum: infer E extends readonly any[] } ? E[number]
    // Handle oneOf (not yet supported in schema.ts, so commenting out)
    // : T extends { oneOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema ?
    //         | SchemaWithoutCell<F, Root, DecrementDepth<Depth>>
    //         | SchemaWithoutCell<{ oneOf: R }, Root, Depth>
    //       : never
    //     : never
    // Handle anyOf
    : T extends { anyOf: infer U extends readonly JSONSchema[] }
      ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
        ? F extends JSONSchema ?
            | SchemaWithoutCell<F, Root, DecrementDepth<Depth>>
            | SchemaWithoutCell<{ anyOf: R }, Root, Depth>
        : never
      : never
    // Handle allOf (merge all types) (not yet supported in schema.ts, so commenting out)
    // : T extends { allOf: infer U extends readonly JSONSchema[] }
    //   ? U extends readonly [infer F, ...infer R extends JSONSchema[]]
    //     ? F extends JSONSchema
    //       ?
    //         & SchemaWithoutCell<F, Root, Depth>
    //         & MergeAllOfWithoutCell<{ allOf: R }, Root, Depth>
    //     : never
    //   : Record<string | number | symbol, never>
    // Handle different primitive types
    : T extends { type: "string" } ? string
    : T extends { type: "number" | "integer" } ? number
    : T extends { type: "boolean" } ? boolean
    : T extends { type: "null" } ? null
    // Handle array type
    : T extends { type: "array" }
      ? T extends { items: infer I }
        ? I extends JSONSchema
          ? SchemaWithoutCell<I, Root, DecrementDepth<Depth>>[]
        : unknown[]
      : unknown[] // No items specified, allow any items
    // Handle object type
    : T extends { type: "object" }
      ? T extends { properties: infer P }
        ? P extends Record<string, JSONSchema>
          ? ObjectFromPropertiesWithoutCell<
            P,
            T extends { required: readonly string[] } ? T["required"] : [],
            Root,
            Depth,
            T extends { additionalProperties: infer AP extends JSONSchema } ? AP
              : false,
            GetDefaultKeys<T>
          >
        : Record<string, unknown>
        // Object without properties - check additionalProperties
      : T extends { additionalProperties: infer AP }
        ? AP extends false ? Record<string | number | symbol, never> // Empty object
        : AP extends true ? Record<string | number | symbol, unknown>
        : AP extends JSONSchema ? Record<
            string | number | symbol,
            SchemaWithoutCell<AP, Root, DecrementDepth<Depth>>
          >
        : Record<string | number | symbol, unknown>
        // Default for object with no properties and no additionalProperties specified
      : Record<string, unknown>
    // Default case
    : any;

type ObjectFromPropertiesWithoutCell<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  AP extends JSONSchema = false,
  DK extends string = never,
> =
  // Required properties (either explicitly required or has a default value)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? K : never
        : never
    ]: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
  }
  // Optional properties (not required and no default)
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? never : K
        : never
    ]?: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
  }
  // Additional properties
  & (
    AP extends false
      // Additional properties off => no-op instead of empty record
      ? Record<never, never>
      : AP extends true
      // Additional properties on => unknown
        ? { [key: string]: unknown }
      : AP extends JSONSchema
      // Additional properties is another schema => map them
        ? { [key: string]: SchemaWithoutCell<AP, Root, DecrementDepth<Depth>> }
      : Record<string | number | symbol, never>
  );

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "common-fragment";

/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export const h = Object.assign(function h(
  name: string | ((...args: any[]) => VNode),
  props: { [key: string]: any } | null,
  ...children: RenderNode[]
): VNode {
  if (typeof name === "function") {
    return name({
      ...(props ?? {}),
      children: children.flat(),
    });
  } else {
    return {
      type: "vnode",
      name,
      props: props ?? {},
      children: children.flat(),
    };
  }
}, {
  fragment({ children }: { children: RenderNode[] }) {
    return h(FRAGMENT_ELEMENT, null, ...children);
  },
});

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | Cell<any>
    | Stream<any>;
};

/** A child in a view can be one of a few things */
export type RenderNode =
  | VNode
  | string
  | number
  | boolean
  | Cell<RenderNode>
  | RenderNode[];

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children?: RenderNode;
  [UI]?: VNode;
};
