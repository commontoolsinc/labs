import { JSONSchema } from "@commontools/builder";
import { Cell } from "./cell.js";

// Main utility type that converts JSON Schema to TypeScript types
export type Schema<T extends JSONSchema, Root extends JSONSchema = T> =
  // Handle asCell attribute - wrap the result in Cell<T>
  T extends { asCell: true }
    ? Cell<Schema<Omit<T, "asCell">, Root>>
    : // Handle $ref to root
      T extends { $ref: "#" }
      ? Schema<Root, Root>
      : // Handle other $ref (placeholder - would need a schema registry for other refs)
        T extends { $ref: string }
        ? any
        : // Handle enum values
          T extends { enum: infer E extends readonly any[] }
          ? E[number]
          : // Handle oneOf
            T extends { oneOf: infer U extends readonly any[] }
            ? FromUnion<U, Root>
            : // Handle anyOf
              T extends { anyOf: infer U extends readonly any[] }
              ? FromUnion<U, Root>
              : // Handle allOf (merge all types)
                T extends { allOf: infer U extends readonly any[] }
                ? MergeAllOf<U, Root>
                : // Handle different primitive types
                  T extends { type: "string" }
                  ? string
                  : T extends { type: "number" | "integer" }
                    ? number
                    : T extends { type: "boolean" }
                      ? boolean
                      : T extends { type: "null" }
                        ? null
                        : // Handle array type
                          T extends { type: "array" }
                          ? T extends { items: infer I }
                            ? I extends JSONSchema
                              ? Schema<I, Root>[]
                              : any[]
                            : any[] // No items specified, allow any items
                          : // Handle object type
                            T extends { type: "object" }
                            ? T extends { properties: infer P }
                              ? P extends Record<string, JSONSchema>
                                ? ObjectFromProperties<
                                    P,
                                    T extends { required: readonly string[] }
                                      ? T["required"]
                                      : never,
                                    Root,
                                    T extends {
                                      additionalProperties: infer AP extends boolean | JSONSchema;
                                    }
                                      ? AP
                                      : true
                                  >
                                : Record<string, unknown>
                              : // Object without properties - check additionalProperties
                                T extends { additionalProperties: infer AP }
                                ? AP extends false
                                  ? {}
                                  : AP extends true
                                    ? Record<string, unknown>
                                    : AP extends JSONSchema
                                      ? Record<string, Schema<AP, Root>>
                                      : Record<string, unknown>
                                : // Default for object with no properties and no additionalProperties specified
                                  Record<string, unknown>
                            : // Default case
                              unknown;

// Helper type to handle oneOf and anyOf
type FromUnion<T extends readonly any[], Root extends JSONSchema> = T extends readonly [
  infer F,
  ...infer R extends readonly any[],
]
  ? F extends JSONSchema
    ? Schema<F, Root> | FromUnion<R, Root>
    : never
  : never;

// Helper type to handle allOf (merges all types together)
type MergeAllOf<T extends readonly any[], Root extends JSONSchema> = T extends readonly [
  infer F,
  ...infer R extends readonly any[],
]
  ? F extends JSONSchema
    ? Schema<F, Root> & MergeAllOf<R, Root>
    : never
  : {};

// Helper type for building object types from properties
type ObjectFromProperties<
  P extends Record<string, JSONSchema>,
  R extends readonly string[] | never,
  Root extends JSONSchema,
  AP extends boolean | JSONSchema = true,
> =
  // Required properties
  {
    [K in keyof P as K extends string
      ? R extends readonly any[]
        ? K extends R[number]
          ? K
          : never
        : never
      : never]: Schema<P[K], Root>;
  } & {
    // Optional properties
    [K in keyof P as K extends string
      ? R extends readonly any[]
        ? K extends R[number]
          ? never
          : K
        : K
      : never]?: Schema<P[K], Root>;
  } & (AP extends false // Additional properties
      ? {}
      : AP extends true
        ? { [key: string]: unknown }
        : AP extends JSONSchema
          ? { [key: string]: Schema<AP, Root> }
          : {}); // Fallback case
