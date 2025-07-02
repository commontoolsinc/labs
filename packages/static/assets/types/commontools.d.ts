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
export interface Cell<T = any> {
    get(): T;
    set(value: T): void;
    send(value: T): void;
    update(values: Partial<T>): void;
    push(...value: T extends (infer U)[] ? U[] : never): void;
    equals(other: Cell<any>): boolean;
    key<K extends keyof T>(valueKey: K): Cell<T[K]>;
}
export interface Stream<T> {
    send(event: T): void;
}
export type OpaqueRef<T> = OpaqueRefMethods<T> & (T extends Array<infer U> ? Array<OpaqueRef<U>> : T extends object ? {
    [K in keyof T]: OpaqueRef<T[K]>;
} : T);
export type Opaque<T> = OpaqueRef<T> | (T extends Array<infer U> ? Array<Opaque<U>> : T extends object ? {
    [K in keyof T]: Opaque<T[K]>;
} : T);
export interface OpaqueRefMethods<T> {
    get(): OpaqueRef<T>;
    set(value: Opaque<T> | T): void;
    key<K extends keyof T>(key: K): OpaqueRef<T[K]>;
    setDefault(value: Opaque<T> | T): void;
    setName(name: string): void;
    setSchema(schema: JSONSchema): void;
    map<S>(fn: (element: T extends Array<infer U> ? Opaque<U> : Opaque<T>, index: Opaque<number>, array: T) => Opaque<S>): Opaque<S[]>;
}
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
    with: (inputs: Opaque<T>) => OpaqueRef<R>;
};
export type NodeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & (Module | Handler | Recipe) & toJSON;
export type RecipeFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & Recipe & toJSON;
export type ModuleFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & Module & toJSON;
export type HandlerFactory<T, R> = ((inputs: Opaque<T>) => OpaqueRef<R>) & Handler<T, R> & toJSON;
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
export type JSONSchema = {
    readonly $ref?: string;
    readonly $defs?: Readonly<Record<string, JSONSchema>>;
    readonly allOf?: readonly (JSONSchema | boolean)[];
    readonly anyOf?: readonly JSONSchema[];
    readonly oneOf?: readonly (JSONSchema | boolean)[];
    readonly not?: JSONSchema | boolean;
    readonly if?: JSONSchema | boolean;
    readonly then?: JSONSchema | boolean;
    readonly else?: JSONSchema | boolean;
    readonly dependentSchemas?: Readonly<Record<string, JSONSchema>>;
    readonly prefixItems?: (JSONSchema | boolean)[];
    readonly items?: Readonly<JSONSchema>;
    readonly contains?: JSONSchema | boolean;
    readonly properties?: Readonly<Record<string, JSONSchema>>;
    readonly patternProperties?: Readonly<Record<string, JSONSchema | boolean>>;
    readonly additionalProperties?: JSONSchema | boolean;
    readonly propertyNames?: JSONSchema | boolean;
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
    readonly contentSchema?: JSONSchema | boolean;
    readonly title?: string;
    readonly description?: string;
    readonly default?: Readonly<JSONValue>;
    readonly readOnly?: boolean;
    readonly writeOnly?: boolean;
    readonly examples?: readonly Readonly<JSONValue>[];
    readonly [ID]?: unknown;
    readonly [ID_FIELD]?: unknown;
    readonly asCell?: boolean;
    readonly asStream?: boolean;
    readonly ifc?: {
        classification?: string[];
        integrity?: string[];
    };
};
export interface BuiltInLLMParams {
    messages?: string[];
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
}
export interface BuiltInLLMState<T> {
    pending: boolean;
    result?: T;
    partial?: string;
    error: unknown;
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
export type LiftFunction = {
    <T extends JSONSchema = JSONSchema, R extends JSONSchema = JSONSchema>(argumentSchema: T, resultSchema: R, implementation: (input: Schema<T>) => Schema<R>): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;
    <T, R>(implementation: (input: T) => R): ModuleFactory<T, R>;
    <T>(implementation: (input: T) => any): ModuleFactory<T, ReturnType<typeof implementation>>;
    <T extends (...args: any[]) => any>(implementation: T): ModuleFactory<Parameters<T>[0], ReturnType<T>>;
};
export type HandlerFunction = {
    <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(eventSchema: E, stateSchema: T, handler: (event: Schema<E>, props: Schema<T>) => any): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<E>>;
    <E, T>(eventSchema: JSONSchema, stateSchema: JSONSchema, handler: (event: E, props: T) => any): ModuleFactory<T, E>;
    <E, T>(handler: (event: E, props: T) => any): ModuleFactory<T, E>;
};
export type DeriveFunction = <In, Out>(input: Opaque<In>, f: (input: In) => Out | Promise<Out>) => OpaqueRef<Out>;
export type ComputeFunction = <T>(fn: () => T) => OpaqueRef<T>;
export type RenderFunction = <T>(fn: () => T) => OpaqueRef<T>;
export type StrFunction = (strings: TemplateStringsArray, ...values: any[]) => OpaqueRef<string>;
export type IfElseFunction = <T = any, U = any, V = any>(condition: Opaque<T>, ifTrue: Opaque<U>, ifFalse: Opaque<V>) => OpaqueRef<U | V>;
export type LLMFunction = <T = string>(params: Opaque<BuiltInLLMParams>) => OpaqueRef<BuiltInLLMState<T>>;
export type GenerateObjectFunction = <T = any>(params: Opaque<BuiltInGenerateObjectParams>) => OpaqueRef<BuiltInLLMState<T>>;
export type FetchDataFunction = <T>(params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: RequestInit;
    result?: T;
}>) => Opaque<{
    pending: boolean;
    result: T;
    error: any;
}>;
export type StreamDataFunction = <T>(params: Opaque<{
    url: string;
    options?: RequestInit;
    result?: T;
}>) => Opaque<{
    pending: boolean;
    result: T;
    error: any;
}>;
export type CompileAndRunFunction = <T = any, S = any>(params: Opaque<BuiltInCompileAndRunParams<T>>) => OpaqueRef<BuiltInCompileAndRunState<S>>;
export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<string>;
export type CreateNodeFactoryFunction = <T = any, R = any>(moduleSpec: Module) => ModuleFactory<T, R>;
export type CreateCellFunction = {
    <T>(schema?: JSONSchema, name?: string, value?: T): Cell<T>;
    <S extends JSONSchema = JSONSchema>(schema: S, name?: string, value?: Schema<S>): Cell<Schema<S>>;
};
export type CellFunction = <T>(value?: T, schema?: JSONSchema) => OpaqueRef<T>;
export type StreamFunction = <T>(initial?: T) => OpaqueRef<T>;
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;
export interface RecipeEnvironment {
    readonly apiUrl: URL;
}
export type GetRecipeEnvironmentFunction = () => RecipeEnvironment;
export declare const recipe: RecipeFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const derive: DeriveFunction;
export declare const compute: ComputeFunction;
export declare const render: RenderFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const llm: LLMFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const fetchData: FetchDataFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
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
export type Schema<T extends JSONSchema, Root extends JSONSchema = T, Depth extends DepthLevel = 9> = Depth extends 0 ? unknown : T extends {
    asCell: true;
} ? Cell<Schema<Omit<T, "asCell">, Root, Depth>> : T extends {
    asStream: true;
} ? Stream<Schema<Omit<T, "asStream">, Root, Depth>> : T extends {
    $ref: "#";
} ? Schema<Omit<Root, "asCell" | "asStream">, Root, DecrementDepth<Depth>> : T extends {
    $ref: string;
} ? any : T extends {
    enum: infer E extends readonly any[];
} ? E[number] : T extends {
    anyOf: infer U extends readonly JSONSchema[];
} ? U extends readonly [infer F, ...infer R extends JSONSchema[]] ? F extends JSONSchema ? Schema<F, Root, DecrementDepth<Depth>> | Schema<{
    anyOf: R;
}, Root, Depth> : never : never : T extends {
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
} ? I extends JSONSchema ? Array<Schema<I, Root, DecrementDepth<Depth>>> : unknown[] : unknown[] : T extends {
    type: "object";
} ? T extends {
    properties: infer P;
} ? P extends Record<string, JSONSchema> ? ObjectFromProperties<P, T extends {
    required: readonly string[];
} ? T["required"] : [], Root, Depth, T extends {
    additionalProperties: infer AP extends boolean | JSONSchema;
} ? AP : false, GetDefaultKeys<T>> : Record<string, unknown> : T extends {
    additionalProperties: infer AP;
} ? AP extends false ? Record<string | number | symbol, never> : AP extends true ? Record<string | number | symbol, unknown> : AP extends JSONSchema ? Record<string | number | symbol, Schema<AP, Root, DecrementDepth<Depth>>> : Record<string | number | symbol, unknown> : Record<string, unknown> : any;
type GetDefaultKeys<T extends JSONSchema> = T extends {
    default: infer D;
} ? D extends Record<string, any> ? keyof D & string : never : never;
type ObjectFromProperties<P extends Record<string, JSONSchema>, R extends readonly string[] | never, Root extends JSONSchema, Depth extends DepthLevel, AP extends boolean | JSONSchema = false, DK extends string = never> = {
    [K in keyof P as K extends string ? K extends R[number] | DK ? K : never : never]: Schema<P[K], Root, DecrementDepth<Depth>>;
} & {
    [K in keyof P as K extends string ? K extends R[number] | DK ? never : K : never]?: Schema<P[K], Root, DecrementDepth<Depth>>;
} & (AP extends false ? Record<never, never> : AP extends true ? {
    [key: string]: unknown;
} : AP extends JSONSchema ? {
    [key: string]: Schema<AP, Root, DecrementDepth<Depth>>;
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
export type SchemaWithoutCell<T extends JSONSchema, Root extends JSONSchema = T, Depth extends DepthLevel = 9> = Depth extends 0 ? unknown : T extends {
    asCell: true;
} ? SchemaWithoutCell<Omit<T, "asCell">, Root, Depth> : T extends {
    asStream: true;
} ? SchemaWithoutCell<Omit<T, "asStream">, Root, Depth> : T extends {
    $ref: "#";
} ? SchemaWithoutCell<Omit<Root, "asCell" | "asStream">, Root, DecrementDepth<Depth>> : T extends {
    $ref: string;
} ? any : T extends {
    enum: infer E extends readonly any[];
} ? E[number] : T extends {
    anyOf: infer U extends readonly JSONSchema[];
} ? U extends readonly [infer F, ...infer R extends JSONSchema[]] ? F extends JSONSchema ? SchemaWithoutCell<F, Root, DecrementDepth<Depth>> | SchemaWithoutCell<{
    anyOf: R;
}, Root, Depth> : never : never : T extends {
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
} ? I extends JSONSchema ? SchemaWithoutCell<I, Root, DecrementDepth<Depth>>[] : unknown[] : unknown[] : T extends {
    type: "object";
} ? T extends {
    properties: infer P;
} ? P extends Record<string, JSONSchema> ? ObjectFromPropertiesWithoutCell<P, T extends {
    required: readonly string[];
} ? T["required"] : [], Root, Depth, T extends {
    additionalProperties: infer AP extends boolean | JSONSchema;
} ? AP : false, GetDefaultKeys<T>> : Record<string, unknown> : T extends {
    additionalProperties: infer AP;
} ? AP extends false ? Record<string | number | symbol, never> : AP extends true ? Record<string | number | symbol, unknown> : AP extends JSONSchema ? Record<string | number | symbol, SchemaWithoutCell<AP, Root, DecrementDepth<Depth>>> : Record<string | number | symbol, unknown> : Record<string, unknown> : any;
type ObjectFromPropertiesWithoutCell<P extends Record<string, JSONSchema>, R extends readonly string[] | never, Root extends JSONSchema, Depth extends DepthLevel, AP extends boolean | JSONSchema = false, DK extends string = never> = {
    [K in keyof P as K extends string ? K extends R[number] | DK ? K : never : never]: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
} & {
    [K in keyof P as K extends string ? K extends R[number] | DK ? never : K : never]?: SchemaWithoutCell<P[K], Root, DecrementDepth<Depth>>;
} & (AP extends false ? Record<never, never> : AP extends true ? {
    [key: string]: unknown;
} : AP extends JSONSchema ? {
    [key: string]: SchemaWithoutCell<AP, Root, DecrementDepth<Depth>>;
} : Record<string | number | symbol, never>);
/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export declare const h: ((name: string | ((...args: any[]) => any), props: {
    [key: string]: any;
} | null, ...children: Child[]) => VNode) & {
    fragment({ children }: {
        children: Child[];
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
export type Child = VNode | string | number | boolean | Cell<Child> | Array<Child>;
/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
    type: "vnode";
    name: string;
    props: Props;
    children: Array<Child> | Cell<Array<Child>>;
};
declare global {
    namespace JSX {
        interface IntrinsicElements {
            [elemName: string]: any;
        }
    }
}
export {};
