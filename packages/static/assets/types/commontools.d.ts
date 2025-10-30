/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public recipe API.
 *
 * Workspace code should import these types via `@commontools/builder`.
 */
export declare const ID: unique symbol;
export declare const ID_FIELD: unique symbol;
export declare const TYPE = "$TYPE";
export declare const NAME = "$NAME";
export declare const UI = "$UI";
/**
 * Brand symbol for identifying different cell types at compile-time.
 * Each cell variant has a unique combination of capability flags.
 */
export declare const CELL_BRAND: unique symbol;
/**
 * Minimal cell type with just the brand, no methods.
 * Used for type-level operations like unwrapping nested cells without
 * creating circular dependencies.
 */
export type BrandedCell<T, Brand extends string = string> = {
    [CELL_BRAND]: Brand;
};
type IsThisObject = IsThisArray | BrandedCell<JSONObject> | BrandedCell<Record<string, unknown>>;
type IsThisArray = BrandedCell<JSONArray> | BrandedCell<Array<unknown>> | BrandedCell<Array<any>> | BrandedCell<unknown> | BrandedCell<any>;
export interface IAnyCell<T> {
}
/**
 * Readable cells can retrieve their current value.
 */
export interface IReadable<T> {
    get(): Readonly<T>;
}
/**
 * Writable cells can update their value.
 */
export interface IWritable<T> {
    set(value: T | AnyCellWrapping<T>): void;
    update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(this: IsThisObject, values: V extends object ? AnyCellWrapping<V> : never): void;
    push(this: IsThisArray, ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never): void;
}
/**
 * Streamable cells can send events.
 */
export interface IStreamable<T> {
    send(event: AnyCellWrapping<T>): void;
}
interface HKT {
    _A: unknown;
    type: unknown;
}
type Apply<F extends HKT, A> = (F & {
    _A: A;
})["type"];
/**
 * A key-addressable, **covariant** view over a structured value `T`.
 *
 * `IKeyableCell` exposes a single method, {@link IKeyableCell.key}, which selects a
 * property from the (possibly branded) value `T` and returns it wrapped in a
 * user-provided type constructor `Wrap` (default: `Cell<…>`). The interface is
 * declared `out T` (covariant) and is designed so that calling `key` preserves
 * both type inference and variance soundness.
 *
 * @template T
 * The underlying (possibly branded) value type. `T` is treated **covariantly**:
 * `IKeyableCell<Sub>` is assignable to `IKeyableCell<Super>` when `Sub` is
 * assignable to `Super`.
 *
 * @template Wrap extends HKT
 * A lightweight higher-kinded “wrapper” that determines the return container for
 * selected fields. For example, `AsCell` wraps as `Cell<A>`, while other wrappers
 * can project to `ReadonlyCell<A>`, `Stream<A>`, etc. Defaults to `AsCell`.
 *
 * @template Any
 * The “fallback” return type used when the provided key does not match a known
 * key (or is widened to `any`). This should usually be `Apply<Wrap, any>`.
 *
 * @remarks
 * ### Variance & soundness
 * The `key` signature is crafted to remain **covariant in `T`**. Internally,
 * it guards the instantiation `K = any` with `unknown extends K ? … : …`, so
 * the return type becomes `Any` (independent of `T`) in that case. For real keys
 * (`K extends keyof UnwrapCell<T>`), the return type is precise and fully inferred.
 *
 * ### Branded / nested cells
 * If a selected property is itself a branded cell (e.g., `BrandedCell<U>`),
 * the return value is a wrapped branded cell, i.e. `Wrap<BrandedCell<U>>`.
 *
 * ### Key inference
 * Passing a string/number/symbol that is a literal and a member of
 * `keyof UnwrapCell<T>` yields precise field types; non-literal or unknown keys
 * fall back to `Any` (e.g., `Cell<any>`).
 *
 * @example
 * // Basic usage with the default wrapper (Cell)
 * declare const userCell: IKeyableCell<{ id: string; profile: { name: string } }>;
 * const idCell = userCell.key("id");         // Cell<string>
 * const profileCell = userCell.key("profile"); // Cell<{ name: string }>
 *
 * // Unknown key falls back to Any (default: Cell<any>)
 * const whatever = userCell.key(Symbol());   // Cell<any>
 *
 * @example
 * // Using a custom wrapper, e.g., ReadonlyCell<A>
 * interface AsReadonlyCell extends HKT { type: ReadonlyCell<this["_A"]> }
 * type ReadonlyUserCell = IKeyableCell<{ id: string }, AsReadonlyCell, Apply<AsReadonlyCell, any>>;
 * declare const ro: ReadonlyUserCell;
 * const idRO = ro.key("id"); // ReadonlyCell<string>
 *
 * @example
 * // Covariance works:
 * declare const sub: IKeyableCell<{ a: string }>;
 * const superCell: IKeyableCell<unknown> = sub; // OK (out T)
 */
export interface IKeyable<out T, Wrap extends HKT> {
    key<K extends PropertyKey>(this: IsThisObject, valueKey: K): KeyResultType<T, K, Wrap>;
}
export type KeyResultType<T, K, Wrap extends HKT> = [unknown] extends [K] ? Apply<Wrap, any> : [0] extends [1 & T] ? Apply<Wrap, any> : T extends BrandedCell<any, any> ? (T extends {
    key(k: K): infer R;
} ? R : Apply<Wrap, never>) : Apply<Wrap, K extends keyof T ? T[K] : any>;
/**
 * Cells that support key() for property access - OpaqueCell variant.
 * OpaqueCell is "sticky" and always returns OpaqueCell<>.
 *
 * Note: And for now it always returns an OpaqueRef<>, until we clean this up.
 */
export interface IKeyableOpaque<T> {
    key<K extends PropertyKey>(this: IsThisObject, valueKey: K): unknown extends K ? OpaqueRef<any> : K extends keyof UnwrapCell<T> ? (0 extends (1 & T) ? OpaqueRef<any> : UnwrapCell<T>[K] extends never ? OpaqueRef<any> : UnwrapCell<T>[K] extends BrandedCell<infer U> ? OpaqueRef<U> : OpaqueRef<UnwrapCell<T>[K]>) : OpaqueRef<any>;
}
/**
 * Cells that can be resolved back to a Cell.
 * Only available on full Cell<T>, not on OpaqueCell or Stream.
 */
export interface IResolvable<T, C extends BrandedCell<T>> {
    resolveAsCell(): C;
}
/**
 * Comparable cells have equals() method.
 * Available on comparable and readable cells.
 */
export interface IEquatable {
    equals(other: AnyCell<any> | object): boolean;
}
/**
 * Cells that allow deriving new cells from existing cells. Currently just
 * .map(), but this will eventually include all Array, String and Number
 * methods.
 */
export interface IDerivable<T> {
    map<S>(this: IsThisObject, fn: (element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>, index: OpaqueRef<number>, array: OpaqueRef<T>) => Opaque<S>): OpaqueRef<S[]>;
    mapWithPattern<S>(this: IsThisObject, op: Recipe, params: Record<string, any>): OpaqueRef<S[]>;
}
export interface IOpaquable<T> {
    /** deprecated */
    get(): T;
    /** deprecated */
    set(newValue: Opaque<Partial<T>>): void;
    /** deprecated */
    setDefault(value: Opaque<T> | T): void;
    /** deprecated */
    setPreExisting(ref: any): void;
    /** deprecated */
    setName(name: string): void;
    /** deprecated */
    setSchema(schema: JSONSchema): void;
}
/**
 * Base type for all cell variants that has methods. Internal API augments this
 * interface with internal only API. Uses a second symbol brand to distinguish
 * from core cell brand without any methods.
 */
export interface AnyCell<T = unknown> extends BrandedCell<T>, IAnyCell<T> {
}
/**
 * Opaque cell reference - only supports keying and derivation, not direct I/O.
 * Has .key(), .map(), .mapWithPattern()
 * Does NOT have .get()/.set()/.send()/.equals()/.resolveAsCell()
 */
export interface IOpaqueCell<T> extends IKeyableOpaque<T>, IDerivable<T>, IOpaquable<T> {
}
export interface OpaqueCell<T> extends BrandedCell<T, "opaque">, IOpaqueCell<T> {
}
/**
 * Full cell with read, write capabilities.
 * Has .get(), .set(), .update(), .push(), .equals(), .key(), .resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface AsCell extends HKT {
    type: Cell<this["_A"]>;
}
export interface ICell<T> extends IAnyCell<T>, IReadable<T>, IWritable<T>, IStreamable<T>, IEquatable, IKeyable<T, AsCell>, IResolvable<T, Cell<T>> {
}
export interface Cell<T = unknown> extends BrandedCell<T, "cell">, ICell<T> {
}
/**
 * Stream-only cell - can only send events, not read or write.
 * Has .send() only
 * Does NOT have .key()/.equals()/.get()/.set()/.resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface Stream<T> extends BrandedCell<T, "stream">, IAnyCell<T>, IStreamable<T> {
}
/**
 * Comparable-only cell - just for equality checks and keying.
 * Has .equals(), .key()
 * Does NOT have .resolveAsCell()/.get()/.set()/.send()
 */
interface AsComparableCell extends HKT {
    type: ComparableCell<this["_A"]>;
}
export interface ComparableCell<T> extends BrandedCell<T, "comparable">, IAnyCell<T>, IEquatable, IKeyable<T, AsComparableCell> {
}
/**
 * Read-only cell variant.
 * Has .get(), .equals(), .key()
 * Does NOT have .resolveAsCell()/.set()/.send()
 */
interface AsReadonlyCell extends HKT {
    type: ReadonlyCell<this["_A"]>;
}
export interface ReadonlyCell<T> extends BrandedCell<T, "readonly">, IAnyCell<T>, IReadable<T>, IEquatable, IKeyable<T, AsReadonlyCell> {
}
/**
 * Write-only cell variant.
 * Has .set(), .update(), .push(), .key()
 * Does NOT have .resolveAsCell()/.get()/.equals()/.send()
 */
interface AsWriteonlyCell extends HKT {
    type: WriteonlyCell<this["_A"]>;
}
export interface WriteonlyCell<T> extends BrandedCell<T, "writeonly">, IAnyCell<T>, IWritable<T>, IKeyable<T, AsWriteonlyCell> {
}
/**
 * OpaqueRef is a variant of OpaqueCell with recursive proxy behavior.
 * Each key access returns another OpaqueRef, allowing chained property access.
 * This is temporary until AST transformation handles .key() automatically.
 */
export type OpaqueRef<T> = OpaqueCell<T> & (T extends Array<infer U> ? Array<OpaqueRef<U>> : T extends object ? {
    [K in keyof T]: OpaqueRef<T[K]>;
} : T);
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
export type Opaque<T> = T | OpaqueRef<T> | (T extends Array<infer U> ? Array<Opaque<U>> : T extends object ? {
    [K in keyof T]: Opaque<T[K]>;
} : T);
/**
 * Recursively unwraps BrandedCell types at any nesting level.
 * UnwrapCell<BrandedCell<BrandedCell<string>>> = string
 * UnwrapCell<BrandedCell<{ a: BrandedCell<number> }>> = { a: BrandedCell<number> }
 *
 * Special cases:
 * - UnwrapCell<any> = any
 * - UnwrapCell<unknown> = unknown (preserves unknown)
 */
export type UnwrapCell<T> = 0 extends (1 & T) ? T : T extends BrandedCell<infer S> ? UnwrapCell<S> : T;
/**
 * AnyCellWrapping is used for write operations (.set(), .push(), .update()). It
 * is a type utility that allows any part of type T to be wrapped in AnyCell<>,
 * and allow any part of T that is currently wrapped in AnyCell<> to be used
 * unwrapped. This is designed for use with cell method parameters, allowing
 * flexibility in how values are passed. The ID and ID_FIELD metadata symbols
 * allows controlling id generation and can only be passed to write operations.
 */
export type AnyCellWrapping<T> = T extends BrandedCell<infer U> ? AnyCellWrapping<U> | BrandedCell<AnyCellWrapping<U>> : T extends Array<infer U> ? Array<AnyCellWrapping<U>> | BrandedCell<Array<AnyCellWrapping<U>>> : T extends object ? {
    [K in keyof T]: AnyCellWrapping<T[K]>;
} & {
    [ID]?: AnyCellWrapping<JSONValue>;
    [ID_FIELD]?: string;
} | BrandedCell<{
    [K in keyof T]: AnyCellWrapping<T[K]>;
}> : T | BrandedCell<T>;
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
export type NodeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & (Module | Handler | Recipe) & toJSON;
export type RecipeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & Recipe & toJSON;
export type ModuleFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & Module & toJSON;
export type HandlerFactory<T, R> = ((inputs: Opaque<StripCell<T>>) => OpaqueRef<R>) & Handler<T, R> & toJSON;
export type JSONValue = null | boolean | number | string | JSONArray | JSONObject & IDFields;
export interface JSONArray extends ArrayLike<JSONValue> {
}
export interface JSONObject extends Record<string, JSONValue> {
}
export interface IDFields {
    [ID]?: unknown;
    [ID_FIELD]?: unknown;
}
export type JSONSchemaTypes = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
export type JSONSchema = JSONSchemaObj | boolean;
export type JSONSchemaObj = {
    readonly $ref?: string;
    readonly $defs?: Readonly<Record<string, JSONSchema>>;
    /** @deprecated Use `$defs` for 2019-09/Draft 8 or later */
    readonly definitions?: Readonly<Record<string, JSONSchema>>;
    readonly allOf?: readonly (JSONSchema)[];
    readonly anyOf?: readonly (JSONSchema)[];
    readonly oneOf?: readonly (JSONSchema)[];
    readonly not?: JSONSchema;
    readonly if?: JSONSchema;
    readonly then?: JSONSchema;
    readonly else?: JSONSchema;
    readonly dependentSchemas?: Readonly<Record<string, JSONSchema>>;
    readonly prefixItems?: readonly (JSONSchema)[];
    readonly items?: Readonly<JSONSchema>;
    readonly contains?: JSONSchema;
    readonly properties?: Readonly<Record<string, JSONSchema>>;
    readonly patternProperties?: Readonly<Record<string, JSONSchema>>;
    readonly additionalProperties?: JSONSchema;
    readonly propertyNames?: JSONSchema;
    readonly type?: JSONSchemaTypes | readonly JSONSchemaTypes[];
    readonly enum?: readonly Readonly<JSONValue>[];
    readonly const?: Readonly<JSONValue>;
    readonly multipleOf?: number;
    readonly maximum?: number;
    readonly exclusiveMaximum?: number;
    readonly minimum?: number;
    readonly exclusiveMinimum?: number;
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly pattern?: string;
    readonly maxItems?: number;
    readonly minItems?: number;
    readonly uniqueItems?: boolean;
    readonly maxContains?: number;
    readonly minContains?: number;
    readonly maxProperties?: number;
    readonly minProperties?: number;
    readonly required?: readonly string[];
    readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
    readonly format?: string;
    readonly contentEncoding?: string;
    readonly contentMediaType?: string;
    readonly contentSchema?: JSONSchema;
    readonly title?: string;
    readonly description?: string;
    readonly default?: Readonly<JSONValue>;
    readonly readOnly?: boolean;
    readonly writeOnly?: boolean;
    readonly examples?: readonly Readonly<JSONValue>[];
    readonly $schema?: string;
    readonly $comment?: string;
    readonly [ID]?: unknown;
    readonly [ID_FIELD]?: unknown;
    readonly asCell?: boolean;
    readonly asStream?: boolean;
    readonly ifc?: {
        classification?: string[];
        integrity?: string[];
    };
};
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
    output: {
        type: "text";
        value: string;
    } | {
        type: "json";
        value: any;
    };
};
export type BuiltInLLMContentPart = BuiltInLLMTextPart | BuiltInLLMImagePart | BuiltInLLMToolCallPart | BuiltInLLMToolResultPart;
export type BuiltInLLMContent = string | BuiltInLLMContentPart[];
export type BuiltInLLMMessage = {
    role: "user" | "assistant" | "system" | "tool";
    content: BuiltInLLMContent;
};
export type BuiltInLLMTool = {
    description?: string;
} & ({
    pattern: Recipe;
    handler?: never;
} | {
    handler: Stream<any> | OpaqueRef<any>;
    pattern?: never;
});
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
    files: Array<{
        name: string;
        contents: string;
    }>;
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
export type RecipeFunction = {
    <S extends JSONSchema>(argumentSchema: S, fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => any): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;
    <S extends JSONSchema, R>(argumentSchema: S, fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => Opaque<R>): RecipeFactory<SchemaWithoutCell<S>, R>;
    <S extends JSONSchema, RS extends JSONSchema>(argumentSchema: S, resultSchema: RS, fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => Opaque<SchemaWithoutCell<RS>>): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;
    <T>(argumentSchema: string | JSONSchema, fn: (input: OpaqueRef<Required<T>>) => any): RecipeFactory<T, ReturnType<typeof fn>>;
    <T, R>(argumentSchema: string | JSONSchema, fn: (input: OpaqueRef<Required<T>>) => Opaque<R>): RecipeFactory<T, R>;
    <T, R>(argumentSchema: string | JSONSchema, resultSchema: JSONSchema, fn: (input: OpaqueRef<Required<T>>) => Opaque<R>): RecipeFactory<T, R>;
};
export type PatternToolFunction = <T, E extends Partial<T> = Record<PropertyKey, never>>(fnOrRecipe: ((input: OpaqueRef<Required<T>>) => any) | RecipeFactory<T, any>, extraParams?: Opaque<E>) => OpaqueRef<Omit<T, keyof E>>;
export type LiftFunction = {
    <T extends JSONSchema = JSONSchema, R extends JSONSchema = JSONSchema>(argumentSchema: T, resultSchema: R, implementation: (input: Schema<T>) => Schema<R>): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;
    <T, R>(implementation: (input: T) => R): ModuleFactory<T, R>;
    <T>(implementation: (input: T) => any): ModuleFactory<T, ReturnType<typeof implementation>>;
    <T extends (...args: any[]) => any>(implementation: T): ModuleFactory<Parameters<T>[0], ReturnType<T>>;
    <T, R>(argumentSchema?: JSONSchema, resultSchema?: JSONSchema, implementation?: (input: T) => R): ModuleFactory<T, R>;
};
export type HandlerState<T> = T extends Cell<any> ? T : T extends Stream<any> ? T : T extends Array<infer U> ? ReadonlyArray<HandlerState<U>> : T extends object ? {
    readonly [K in keyof T]: HandlerState<T[K]>;
} : T;
export type HandlerFunction = {
    <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(eventSchema: E, stateSchema: T, handler: (event: Schema<E>, props: Schema<T>) => any): ModuleFactory<StripCell<SchemaWithoutCell<T>>, SchemaWithoutCell<E>>;
    <E, T>(eventSchema: JSONSchema, stateSchema: JSONSchema, handler: (event: E, props: HandlerState<T>) => any): ModuleFactory<StripCell<T>, E>;
    <E, T>(handler: (event: E, props: T) => any, options: {
        proxy: true;
    }): ModuleFactory<StripCell<T>, E>;
    <E, T>(handler: (event: E, props: HandlerState<T>) => any): ModuleFactory<StripCell<T>, E>;
};
export type DeriveFunction = {
    <InputSchema extends JSONSchema = JSONSchema, ResultSchema extends JSONSchema = JSONSchema>(argumentSchema: InputSchema, resultSchema: ResultSchema, input: Opaque<SchemaWithoutCell<InputSchema>>, f: (input: Schema<InputSchema>) => Schema<ResultSchema>): OpaqueRef<SchemaWithoutCell<ResultSchema>>;
    <In, Out>(input: Opaque<In>, f: (input: In) => Out): OpaqueRef<Out>;
};
export type ComputeFunction = <T>(fn: () => T) => OpaqueRef<T>;
export type RenderFunction = <T>(fn: () => T) => OpaqueRef<T>;
export type StrFunction = (strings: TemplateStringsArray, ...values: any[]) => OpaqueRef<string>;
export type IfElseFunction = <T = any, U = any, V = any>(condition: Opaque<T>, ifTrue: Opaque<U>, ifFalse: Opaque<V>) => OpaqueRef<U | V>;
export type LLMFunction = (params: Opaque<BuiltInLLMParams>) => OpaqueRef<BuiltInLLMState>;
export type LLMDialogFunction = (params: Opaque<BuiltInLLMParams>) => OpaqueRef<BuiltInLLMDialogState>;
export type GenerateObjectFunction = <T = any>(params: Opaque<BuiltInGenerateObjectParams>) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;
export type FetchOptions = {
    body?: JSONValue;
    headers?: Record<string, string>;
    cache?: "default" | "no-store" | "reload" | "no-cache" | "force-cache" | "only-if-cached";
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
    redirect?: "follow" | "error" | "manual";
};
export type FetchDataFunction = <T>(params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: FetchOptions;
    result?: T;
}>) => OpaqueRef<{
    pending: boolean;
    result: T;
    error: any;
}>;
export type StreamDataFunction = <T>(params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
}>) => OpaqueRef<{
    pending: boolean;
    result: T;
    error: any;
}>;
export type CompileAndRunFunction = <T = any, S = any>(params: Opaque<BuiltInCompileAndRunParams<T>>) => OpaqueRef<BuiltInCompileAndRunState<S>>;
export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<string>;
export type WishFunction = {
    <T = unknown>(target: Opaque<string>): OpaqueRef<T | undefined>;
    <T = unknown>(target: Opaque<string>, defaultValue: Opaque<T>): OpaqueRef<T>;
};
export type CreateNodeFactoryFunction = <T = any, R = any>(moduleSpec: Module) => ModuleFactory<T, R>;
export type CreateCellFunction = {
    <T>(schema?: JSONSchema, name?: string, value?: T): Cell<T>;
    <S extends JSONSchema = JSONSchema>(schema: S, name?: string, value?: Schema<S>): Cell<Schema<S>>;
};
export type Default<T, V extends T = T> = T;
export type CellFunction = <T>(value?: T, schema?: JSONSchema) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;
export interface RecipeEnvironment {
    readonly apiUrl: URL;
}
export type GetRecipeEnvironmentFunction = () => RecipeEnvironment;
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
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[] : T extends object ? ({
    -readonly [P in keyof T]: Mutable<T[P]>;
}) : T;
export declare const schema: <T extends JSONSchema>(schema: T) => T;
export declare const toSchema: <T>(_options?: Partial<JSONSchema>) => JSONSchema;
export type StripCell<T> = T extends Cell<infer U> ? StripCell<U> : T extends Array<infer U> ? StripCell<U>[] : T extends object ? {
    [K in keyof T]: StripCell<T[K]>;
} : T;
export type WishKey = `/${string}` | `#${string}`;
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
type SplitPath<S extends string> = S extends "#" ? [] : S extends `#/${infer Rest}` ? SplitPathSegments<Rest> : never;
type SplitPathSegments<S extends string> = S extends `${infer First}/${infer Rest}` ? [First, ...SplitPathSegments<Rest>] : [S];
/**
 * Navigate through a schema following a path of keys.
 * Returns never if the path doesn't exist.
 */
type NavigatePath<Schema extends JSONSchema, Path extends readonly string[], Depth extends DepthLevel = 9> = Depth extends 0 ? unknown : Path extends readonly [
    infer First extends string,
    ...infer Rest extends string[]
] ? Schema extends Record<string, any> ? First extends keyof Schema ? NavigatePath<Schema[First], Rest, DecrementDepth<Depth>> : never : never : Schema;
/**
 * Resolve a $ref string to the target schema.
 *
 * Supports:
 * - "#" (self-reference to root)
 * - "#/path/to/def" (JSON Pointer within document)
 *
 * External refs (URLs) return any.
 */
type ResolveRef<RefString extends string, Root extends JSONSchema, Depth extends DepthLevel> = RefString extends "#" ? Root : RefString extends `#/${string}` ? SplitPath<RefString> extends infer Path extends readonly string[] ? NavigatePath<Root, Path, Depth> : never : any;
/**
 * Merge two schemas, with left side taking precedence.
 * Used to apply ref site siblings to resolved target schema.
 */
type MergeSchemas<Left extends JSONSchema, Right extends JSONSchema> = Left extends boolean ? Left : Right extends boolean ? Right extends true ? Left : false : {
    [K in keyof Left | keyof Right]: K extends keyof Left ? Left[K] : K extends keyof Right ? Right[K] : never;
};
type MergeRefSiteWithTargetGeneric<RefSite extends JSONSchema, Target extends JSONSchema, Root extends JSONSchema, Depth extends DepthLevel, WrapCells extends boolean> = RefSite extends {
    $ref: string;
} ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends infer Merged extends JSONSchema ? SchemaInner<Merged, Root, Depth, WrapCells> : never : never;
type SchemaAnyOf<Schemas extends readonly JSONSchema[], Root extends JSONSchema, Depth extends DepthLevel, WrapCells extends boolean> = {
    [I in keyof Schemas]: Schemas[I] extends JSONSchema ? SchemaInner<Schemas[I], Root, DecrementDepth<Depth>, WrapCells> : never;
}[number];
type SchemaArrayItems<Items, Root extends JSONSchema, Depth extends DepthLevel, WrapCells extends boolean> = Items extends JSONSchema ? Array<SchemaInner<Items, Root, DecrementDepth<Depth>, WrapCells>> : unknown[];
type SchemaCore<T extends JSONSchema, Root extends JSONSchema, Depth extends DepthLevel, WrapCells extends boolean> = T extends {
    $ref: "#";
} ? SchemaInner<Omit<Root, "asCell" | "asStream">, Root, DecrementDepth<Depth>, WrapCells> : T extends {
    $ref: infer RefStr extends string;
} ? MergeRefSiteWithTargetGeneric<T, ResolveRef<RefStr, Root, DecrementDepth<Depth>>, Root, DecrementDepth<Depth>, WrapCells> : T extends {
    enum: infer E extends readonly any[];
} ? E[number] : T extends {
    anyOf: infer U extends readonly JSONSchema[];
} ? SchemaAnyOf<U, Root, Depth, WrapCells> : T extends {
    type: "string";
} ? string : T extends {
    type: "number" | "integer";
} ? number : T extends {
    type: "boolean";
} ? boolean : T extends {
    type: "null";
} ? null : T extends {
    type: "array";
} ? T extends {
    items: infer I;
} ? SchemaArrayItems<I, Root, Depth, WrapCells> : unknown[] : T extends {
    type: "object";
} ? T extends {
    properties: infer P;
} ? P extends Record<string, JSONSchema> ? ObjectFromProperties<P, T extends {
    required: readonly string[];
} ? T["required"] : [], Root, Depth, T extends {
    additionalProperties: infer AP extends JSONSchema;
} ? AP : false, GetDefaultKeys<T>, WrapCells> : Record<string, unknown> : T extends {
    additionalProperties: infer AP;
} ? AP extends false ? Record<string | number | symbol, never> : AP extends true ? Record<string | number | symbol, unknown> : AP extends JSONSchema ? Record<string | number | symbol, SchemaInner<AP, Root, DecrementDepth<Depth>, WrapCells>> : Record<string | number | symbol, unknown> : Record<string, unknown> : any;
type SchemaInner<T extends JSONSchema, Root extends JSONSchema = T, Depth extends DepthLevel = 9, WrapCells extends boolean = true> = Depth extends 0 ? unknown : T extends {
    asCell: true;
} ? WrapCells extends true ? Cell<SchemaInner<Omit<T, "asCell">, Root, Depth, WrapCells>> : SchemaInner<Omit<T, "asCell">, Root, Depth, WrapCells> : T extends {
    asStream: true;
} ? WrapCells extends true ? Stream<SchemaInner<Omit<T, "asStream">, Root, Depth, WrapCells>> : SchemaInner<Omit<T, "asStream">, Root, Depth, WrapCells> : SchemaCore<T, Root, Depth, WrapCells>;
export type Schema<T extends JSONSchema, Root extends JSONSchema = T, Depth extends DepthLevel = 9> = SchemaInner<T, Root, Depth, true>;
type GetDefaultKeys<T extends JSONSchema> = T extends {
    default: infer D;
} ? D extends Record<string, any> ? keyof D & string : never : never;
type ObjectFromProperties<P extends Record<string, JSONSchema>, R extends readonly string[] | never, Root extends JSONSchema, Depth extends DepthLevel, AP extends JSONSchema = false, DK extends string = never, WrapCells extends boolean = true> = {
    [K in keyof P as K extends string ? K extends R[number] | DK ? K : never : never]: SchemaInner<P[K], Root, DecrementDepth<Depth>, WrapCells>;
} & {
    [K in keyof P as K extends string ? K extends R[number] | DK ? never : K : never]?: SchemaInner<P[K], Root, DecrementDepth<Depth>, WrapCells>;
} & (AP extends false ? Record<never, never> : AP extends true ? {
    [key: string]: unknown;
} : AP extends JSONSchema ? {
    [key: string]: SchemaInner<AP, Root, DecrementDepth<Depth>, WrapCells>;
} : Record<string | number | symbol, never>) & IDFields;
type DepthLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
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
type DecrementDepth<D extends DepthLevel> = Decrement[D] & DepthLevel;
export type SchemaWithoutCell<T extends JSONSchema, Root extends JSONSchema = T, Depth extends DepthLevel = 9> = SchemaInner<T, Root, Depth, false>;
/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export declare const h: ((name: string | ((...args: any[]) => VNode), props: {
    [key: string]: any;
} | null, ...children: RenderNode[]) => VNode) & {
    fragment({ children }: {
        children: RenderNode[];
    }): VNode;
};
/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
    [key: string]: string | number | boolean | object | Array<any> | null | Cell<any> | Stream<any>;
};
/** A child in a view can be one of a few things */
export type RenderNode = VNode | string | number | boolean | Cell<RenderNode> | undefined | Opaque<any> | RenderNode[];
/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
    type: "vnode";
    name: string;
    props: Props;
    children?: RenderNode;
    [UI]?: VNode;
};
export {};
