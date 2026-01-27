/**
 * Schema inference system for converting JSONSchema to TypeScript types.
 *
 * This module contains the complex type-level machinery for inferring TypeScript
 * types from JSONSchema definitions. It is separated from the main API to reduce
 * TypeScript compilation overhead for patterns that don't need schema inference.
 *
 * Usage:
 *   import type { Schema } from "commontools/schema";
 *   // or
 *   import type { Schema } from "@commontools/api/schema";
 *
 * When imported, this module also augments the function types from the main API
 * (PatternFunction, DeriveFunction, etc.) with schema-based overloads.
 */

import type {
  Cell,
  HandlerFactory,
  JSONSchema,
  ModuleFactory,
  Opaque,
  OpaqueRef,
  RecipeFactory,
  SELF,
  Stream,
  StripCell,
} from "commontools";

// ===== Helper Types =====

/**
 * Helper type to recursively remove `readonly` properties from type `T`.
 *
 * (Duplicated from @commontools/utils/types.ts, but we want to keep this
 * independent for now)
 */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;

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

type MergeRefSiteWithTargetGeneric<
  RefSite extends JSONSchema,
  Target extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  WrapCells extends boolean,
> = RefSite extends { $ref: string }
  ? MergeSchemas<Omit<RefSite, "$ref">, Target> extends
    infer Merged extends JSONSchema
    ? SchemaInner<Merged, Root, Depth, WrapCells>
  : never
  : never;

type SchemaAnyOf<
  Schemas extends readonly JSONSchema[],
  Root extends JSONSchema,
  Depth extends DepthLevel,
  WrapCells extends boolean,
> = {
  [I in keyof Schemas]: Schemas[I] extends JSONSchema
    ? SchemaInner<Schemas[I], Root, DecrementDepth<Depth>, WrapCells>
    : never;
}[number];

type SchemaArrayItems<
  Items,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  WrapCells extends boolean,
> = Items extends JSONSchema
  ? Array<SchemaInner<Items, Root, DecrementDepth<Depth>, WrapCells>>
  : unknown[];

type SchemaCore<
  T extends JSONSchema,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  WrapCells extends boolean,
> = T extends { $ref: "#" } ? SchemaInner<
    Omit<Root, "asCell" | "asStream">,
    Root,
    DecrementDepth<Depth>,
    WrapCells
  >
  : T extends { $ref: infer RefStr extends string }
    ? MergeRefSiteWithTargetGeneric<
      T,
      ResolveRef<RefStr, Root, DecrementDepth<Depth>>,
      Root,
      DecrementDepth<Depth>,
      WrapCells
    >
  : T extends { enum: infer E extends readonly any[] } ? E[number]
  : T extends { anyOf: infer U extends readonly JSONSchema[] }
    ? SchemaAnyOf<U, Root, Depth, WrapCells>
  : T extends { type: "string" } ? string
  : T extends { type: "number" | "integer" } ? number
  : T extends { type: "boolean" } ? boolean
  : T extends { type: "null" } ? null
  : T extends { type: "array" }
    ? T extends { items: infer I } ? SchemaArrayItems<I, Root, Depth, WrapCells>
    : unknown[]
  : T extends { type: "object" }
    ? T extends { properties: infer P }
      ? P extends Record<string, JSONSchema> ? ObjectFromProperties<
          P,
          T extends { required: readonly string[] } ? T["required"] : [],
          Root,
          Depth,
          T extends { additionalProperties: infer AP extends JSONSchema } ? AP
            : false,
          GetDefaultKeys<T>,
          WrapCells
        >
      : Record<string, unknown>
    : T extends { additionalProperties: infer AP }
      ? AP extends false ? Record<string | number | symbol, never>
      : AP extends true ? Record<string | number | symbol, unknown>
      : AP extends JSONSchema ? Record<
          string | number | symbol,
          SchemaInner<AP, Root, DecrementDepth<Depth>, WrapCells>
        >
      : Record<string | number | symbol, unknown>
    : Record<string, unknown>
  : any;

type SchemaInner<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
  WrapCells extends boolean = true,
> = Depth extends 0 ? unknown
  : T extends { asCell: true }
    ? WrapCells extends true
      ? Cell<SchemaInner<Omit<T, "asCell">, Root, Depth, WrapCells>>
    : SchemaInner<Omit<T, "asCell">, Root, Depth, WrapCells>
  : T extends { asStream: true }
    ? WrapCells extends true
      ? Stream<SchemaInner<Omit<T, "asStream">, Root, Depth, WrapCells>>
    : SchemaInner<Omit<T, "asStream">, Root, Depth, WrapCells>
  : SchemaCore<T, Root, Depth, WrapCells>;

/**
 * Convert a JSONSchema type to its corresponding TypeScript type.
 *
 * This is the main public type for schema inference. It recursively
 * processes the schema, handling:
 * - $ref resolution (both "#" and "#/path/to/def")
 * - anyOf unions
 * - Primitive types (string, number, boolean, null)
 * - Arrays with typed items
 * - Objects with typed properties (required and optional)
 * - Cell and Stream wrapping via asCell/asStream
 *
 * @example
 * const mySchema = {
 *   type: "object",
 *   properties: {
 *     name: { type: "string" },
 *     age: { type: "number" }
 *   },
 *   required: ["name"]
 * } as const;
 *
 * type MyType = Schema<typeof mySchema>;
 * // Result: { name: string; age?: number }
 */
export type Schema<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> = SchemaInner<T, Root, Depth, true>;

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
  WrapCells extends boolean = true,
> =
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? K : never
        : never
    ]: SchemaInner<P[K], Root, DecrementDepth<Depth>, WrapCells>;
  }
  & {
    [
      K in keyof P as K extends string ? K extends R[number] | DK ? never : K
        : never
    ]?: SchemaInner<P[K], Root, DecrementDepth<Depth>, WrapCells>;
  }
  & (
    AP extends false ? Record<never, never>
      : AP extends true ? { [key: string]: unknown }
      : AP extends JSONSchema ? {
          [key: string]: SchemaInner<
            AP,
            Root,
            DecrementDepth<Depth>,
            WrapCells
          >;
        }
      : Record<string | number | symbol, never>
  );

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

/**
 * Like Schema<T> but without Cell/Stream wrapping.
 * Used for type parameters in factory return types.
 */
export type SchemaWithoutCell<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> = SchemaInner<T, Root, Depth, false>;

// ===== Module Augmentation for Schema-based Overloads =====

declare module "commontools" {
  // Augment PatternFunction with schema-based overload
  interface PatternFunction {
    <IS extends JSONSchema = JSONSchema, OS extends JSONSchema = JSONSchema>(
      fn: (
        input: OpaqueRef<Required<Schema<IS>>> & {
          [SELF]: OpaqueRef<Schema<OS>>;
        },
      ) => Opaque<Schema<OS>>,
      argumentSchema: IS,
      resultSchema: OS,
    ): RecipeFactory<SchemaWithoutCell<IS>, SchemaWithoutCell<OS>>;
  }

  // Augment RecipeFunction with schema-based overloads
  /** @deprecated Use pattern() instead */
  interface RecipeFunction {
    <S extends JSONSchema>(
      argumentSchema: S,
      fn: (
        input: OpaqueRef<Required<SchemaWithoutCell<S>>> & {
          [SELF]: OpaqueRef<any>;
        },
      ) => any,
    ): RecipeFactory<SchemaWithoutCell<S>, StripCell<ReturnType<typeof fn>>>;

    <S extends JSONSchema, R>(
      argumentSchema: S,
      fn: (
        input: OpaqueRef<Required<SchemaWithoutCell<S>>> & {
          [SELF]: OpaqueRef<R>;
        },
      ) => Opaque<R>,
    ): RecipeFactory<SchemaWithoutCell<S>, StripCell<R>>;

    <S extends JSONSchema, RS extends JSONSchema>(
      argumentSchema: S,
      resultSchema: RS,
      fn: (
        input: OpaqueRef<Required<SchemaWithoutCell<S>>> & {
          [SELF]: OpaqueRef<SchemaWithoutCell<RS>>;
        },
      ) => Opaque<SchemaWithoutCell<RS>>,
    ): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;
  }

  // Augment LiftFunction with schema-based overload
  interface LiftFunction {
    <T extends JSONSchema = JSONSchema, R extends JSONSchema = JSONSchema>(
      argumentSchema: T,
      resultSchema: R,
      implementation: (input: Schema<T>) => Schema<R>,
    ): ModuleFactory<SchemaWithoutCell<T>, SchemaWithoutCell<R>>;
  }

  // Augment HandlerFunction with schema-based overload
  interface HandlerFunction {
    <E extends JSONSchema = JSONSchema, T extends JSONSchema = JSONSchema>(
      eventSchema: E,
      stateSchema: T,
      handler: (event: Schema<E>, props: Schema<T>) => any,
    ): HandlerFactory<SchemaWithoutCell<T>, SchemaWithoutCell<E>>;
  }

  // Augment DeriveFunction with schema-based overload
  /** @deprecated Use compute() instead */
  interface DeriveFunction {
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
  }

  // Augment WishFunction with schema-based overloads
  interface WishFunction {
    <S extends JSONSchema = JSONSchema>(
      target: Opaque<import("commontools").WishParams>,
      schema: S,
    ): OpaqueRef<Required<import("commontools").WishState<Schema<S>>>>;

    // TODO(seefeld): Remove old interface mid December 2025
    <S extends JSONSchema = JSONSchema>(
      target: Opaque<string>,
      schema: S,
    ): OpaqueRef<Schema<S>>;
  }

  // Augment IResolvable with schema-based getArgumentCell overload
  interface IResolvable<T, C> {
    getArgumentCell<S extends JSONSchema = JSONSchema>(
      schema?: S,
    ): Cell<Schema<S>> | undefined;
  }

  // Augment CellTypeConstructor with schema-based of() overload
  interface CellTypeConstructor<Wrap> {
    of<S extends JSONSchema>(
      value: Schema<S>,
      schema: S,
    ): import("commontools").Apply<Wrap, Schema<S>>;
  }
}
