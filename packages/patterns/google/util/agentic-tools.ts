/// <cts-enable />
/**
 * Agentic Tools - Elegant utilities for creating LLM tool handlers
 *
 * Design goals:
 * - Define schema ONCE, derive everything from it
 * - Single-call tool creation (no currying)
 * - Type-safe: dedupe/timestamp fields checked against schema
 *
 * Usage:
 * ```typescript
 * import { defineItemSchema, listTool } from "./util/agentic-tools.ts";
 *
 * // 1. Define schema ONCE
 * const MembershipSchema = defineItemSchema({
 *   hotelBrand: { type: "string", description: "Hotel chain name" },
 *   membershipNumber: { type: "string", description: "Membership number" },
 *   tier: { type: "string", description: "Status tier" },
 * }, ["hotelBrand", "membershipNumber"]); // required fields
 *
 * // 2. Create tool in ONE call - dedupe fields are type-checked!
 * const reportMembership = listTool(MembershipSchema, {
 *   items: memberships,
 *   dedupe: ["hotelBrand", "membershipNumber"],  // ✓ TypeScript checks these!
 *   // dedupe: ["typo"],  // ✗ TypeScript error!
 * });
 *
 * // 3. Use in additionalTools
 * additionalTools: {
 *   reportMembership: {
 *     description: "Report a found membership",
 *     handler: reportMembership,
 *   },
 * }
 * ```
 */
import { handler, JSONSchema, Writable } from "commontools";

// =============================================================================
// SCHEMA UTILITIES
// =============================================================================

/**
 * Property definition for a schema field.
 */
export interface PropertyDef {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  items?: PropertyDef;
  properties?: Record<string, PropertyDef>;
}

/**
 * A typed schema that preserves field names for type checking.
 * This allows listTool to verify dedupe/timestamp fields at compile time.
 */
export interface TypedSchema<Fields extends string> {
  type: "object";
  properties: Record<string, any>;
  required: string[];
  // Phantom type to carry field names through the type system
  __fields?: Fields;
}

/**
 * Defines an item schema for LLM tools.
 *
 * Automatically adds:
 * - `result: { type: "object", asCell: true }` for tool response
 *
 * The returned schema preserves field names for type-safe listTool usage.
 *
 * @param fields - The data fields the LLM should provide
 * @param required - Array of required field names
 * @returns A typed schema ready for handler use
 */
export function defineItemSchema<T extends Record<string, PropertyDef>>(
  fields: T,
  required: (keyof T)[],
): TypedSchema<Extract<keyof T, string>> {
  return {
    type: "object",
    properties: {
      ...fields,
      // Automatically add result cell for tool response
      result: { type: "object", asCell: true },
    },
    required: required as string[],
  } as TypedSchema<Extract<keyof T, string>>;
}

// =============================================================================
// LIST TOOL - Add items to a list with deduplication
// =============================================================================

/**
 * Configuration for listTool - generic over field names for type safety.
 * Note: items is typed as `any` to accept pattern input cells which have
 * different types than plain Cell<any[]> after CTS transformation.
 */
export interface ListToolConfig<Fields extends string> {
  /** Cell containing the list of items */
  items: any; // Accepts pattern input cells (OpaqueCell, etc.)
  /** Fields that make up the dedup key - MUST be valid field names from schema */
  dedupe: Fields[];
  /** Prefix for generated IDs (default: "item") */
  idPrefix?: string;
  /** Field name for the timestamp - MUST be a valid field name or new field */
  timestamp?: string;
}

// State schema for list tools
const LIST_TOOL_STATE_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: {}, asCell: true },
    dedupeFields: { type: "array", items: { type: "string" } },
    idPrefix: { type: "string" },
    timestampField: { type: "string" },
  },
  required: ["items", "dedupeFields", "idPrefix", "timestampField"],
} as const satisfies JSONSchema;

/**
 * Creates a tool handler that adds items to a list with deduplication.
 *
 * Type-safe: dedupe fields are checked against the schema at compile time.
 *
 * @param schema - Typed schema created with defineItemSchema()
 * @param config - Tool configuration with type-checked field names
 * @returns A bound handler ready for use in additionalTools
 */
export function listTool<Fields extends string>(
  schema: TypedSchema<Fields>,
  config: ListToolConfig<Fields>,
) {
  const { items, dedupe, idPrefix = "item", timestamp = "savedAt" } = config;

  // Convert TypedSchema to JSONSchema by extracting the relevant properties
  // TypedSchema is structurally compatible with JSONSchema, just with extra phantom type
  const jsonSchema: JSONSchema = {
    type: schema.type,
    properties: schema.properties,
    required: schema.required,
  };

  return handler(
    jsonSchema,
    LIST_TOOL_STATE_SCHEMA,
    (input: Record<string, any>, state: {
      items: Writable<any[]>;
      dedupeFields: string[];
      idPrefix: string;
      timestampField: string;
    }) => {
      const currentItems = state.items.get() || [];

      // Generate dedup key
      const dedupeKey = state.dedupeFields
        .map((field) => String(input[field] ?? ""))
        .join(":")
        .toLowerCase();

      const existingKeys = new Set(
        currentItems.map((item: Record<string, any>) =>
          state.dedupeFields
            .map((field) => String(item[field] ?? ""))
            .join(":")
            .toLowerCase()
        ),
      );

      let resultMessage: string;

      if (existingKeys.has(dedupeKey)) {
        console.log(
          `[listTool:${state.idPrefix}] Duplicate skipped: ${dedupeKey}`,
        );
        resultMessage = `Duplicate: ${dedupeKey} already saved`;
      } else {
        const id = `${state.idPrefix}-${Date.now()}-${
          Math.random().toString(36).slice(2, 8)
        }`;
        const newRecord = {
          ...input,
          id,
          [state.timestampField]: Date.now(),
        };
        delete newRecord.result; // Don't save the result cell

        state.items.set([...currentItems, newRecord]);
        console.log(`[listTool:${state.idPrefix}] SAVED: ${dedupeKey}`);
        resultMessage = `Saved: ${dedupeKey}`;
      }

      // Write result for LLM
      if (input.result) {
        input.result.set({ success: true, message: resultMessage });
      }

      return { success: true, message: resultMessage };
    },
  )({
    // Bind the config immediately
    items,
    dedupeFields: dedupe,
    idPrefix,
    timestampField: timestamp,
  });
}

// =============================================================================
// TYPE INFERENCE (for TypeScript convenience)
// =============================================================================

/**
 * Infer TypeScript type from a typed schema.
 *
 * Usage:
 * ```typescript
 * const MembershipSchema = defineItemSchema({ ... }, [...]);
 * type Membership = InferItem<typeof MembershipSchema>;
 * ```
 */
export type InferItem<S> = S extends TypedSchema<infer Fields>
  ? { [K in Fields]: any } & { id: string }
  : never;
