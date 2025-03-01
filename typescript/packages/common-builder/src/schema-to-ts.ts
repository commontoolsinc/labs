import type { JSONSchema } from "./types.ts";
import type { Cell } from "@commontools/runner";

export type Schema<
  T extends JSONSchema,
  Root extends JSONSchema = T,
  Depth extends DepthLevel = 9,
> =
  // If we're out of depth, short-circuit
  Depth extends 0 ? unknown
    // Handle asCell attribute - wrap the result in Cell<T>
    : T extends { asCell: true } ? Cell<Schema<Omit<T, "asCell">, Root, Depth>>
    // Handle $ref to root
    : T extends { $ref: "#" } ? Schema<Root, Root, DecrementDepth<Depth>>
    // Handle other $ref (placeholder - would need a schema registry for other refs)
    : T extends { $ref: string } ? any
    // Handle enum values
    : T extends { enum: infer E extends readonly any[] } ? E[number]
    // Handle oneOf
    : T extends { oneOf: infer U extends readonly any[] }
      ? FromUnion<U, Root, Depth>
    // Handle anyOf
    : T extends { anyOf: infer U extends readonly any[] }
      ? FromUnion<U, Root, Depth>
    // Handle allOf (merge all types)
    : T extends { allOf: infer U extends readonly any[] }
      ? MergeAllOf<U, Root, Depth>
    // Handle different primitive types
    : T extends { type: "string" } ? string
    : T extends { type: "number" | "integer" } ? number
    : T extends { type: "boolean" } ? boolean
    : T extends { type: "null" } ? null
    // Handle array type
    : T extends { type: "array" }
      ? T extends { items: infer I }
        ? I extends JSONSchema ? Schema<I, Root, DecrementDepth<Depth>>[]
        : any[]
      : any[] // No items specified, allow any items
    // Handle object type
    : T extends { type: "object" }
      ? T extends { properties: infer P }
        ? P extends Record<string, JSONSchema> ? ObjectFromProperties<
            P,
            T extends { required: readonly string[] } ? T["required"] : never,
            Root,
            Depth,
            T extends
              { additionalProperties: infer AP extends boolean | JSONSchema }
              ? AP
              : true
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

// Helper type to handle oneOf and anyOf with recursion limit
type FromUnion<
  T extends readonly any[],
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = T extends [infer F, ...infer R extends readonly any[]]
  ? F extends JSONSchema
    ? Schema<F, Root, DecrementDepth<Depth>> | FromUnion<R, Root, Depth>
  : never
  : never;

// Helper type to handle allOf and merges all types together, with recursion limit
type MergeAllOf<
  T extends readonly any[],
  Root extends JSONSchema,
  Depth extends DepthLevel,
> = T extends [infer F, ...infer R extends readonly any[]]
  ? F extends JSONSchema ? Schema<F, Root, Depth> & MergeAllOf<R, Root, Depth>
  : never
  : Record<string | number | symbol, never>; // empty object

// Helper type for building object types from properties
type ObjectFromProperties<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  Depth extends DepthLevel,
  AP extends boolean | JSONSchema = true,
> =
  // Required properties
  & {
    [
      K in keyof P as K extends string
        ? R extends readonly any[] ? K extends R[number] ? K
          : never
        : never
        : never
    ]: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  & {
    // Optional properties
    [
      K in keyof P as K extends string
        ? R extends readonly any[] ? K extends R[number] ? never
          : K
        : K
        : never
    ]?: Schema<P[K], Root, DecrementDepth<Depth>>;
  }
  & (
    AP extends false
      // Additional properties off => empty
      ? Record<string | number | symbol, never>
      : AP extends true
      // Additional properties on => unknown
        ? { [key: string]: unknown }
      : AP extends JSONSchema
      // Additional properties is another schema => map them
        ? { [key: string]: Schema<AP, Root, DecrementDepth<Depth>> }
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
