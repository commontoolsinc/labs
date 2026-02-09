import type ts from "typescript";
import type { JSONSchema } from "@commontools/api";
import { type Mutable } from "@commontools/utils/types";

/**
 * JSON Schema object type - mutable version of the CommonTools JSONSchema interface
 */
export type SchemaDefinition = Mutable<JSONSchema>;

/**
 * Unified context for schema generation - contains all state in one place
 */
export interface GenerationContext {
  // Immutable context (set once)
  /** TypeScript type checker */
  readonly typeChecker: ts.TypeChecker;
  /** Pre-computed cyclic type set */
  readonly cyclicTypes: ReadonlySet<ts.Type>;
  /** Pre-computed cyclic name set */
  readonly cyclicNames: ReadonlySet<string>;

  // Accumulating state (grows during generation)
  /** Named type definitions for $refs */
  definitions: Record<string, SchemaDefinition>;
  /** Which $refs have been emitted */
  emittedRefs: Set<string>;

  // Stack state (push/pop during recursion)
  /** Current recursion path for cycle detection */
  definitionStack: Set<string | ts.Type>;
  /** Currently building these named types */
  inProgressNames: Set<string>;

  // Optional context
  /** Type node for additional context */
  typeNode?: ts.TypeNode;
  /** Optional type registry for synthetic nodes */
  typeRegistry?: WeakMap<ts.Node, ts.Type>;
  /** Widen literal types to base types during schema generation */
  widenLiterals?: boolean;
  /** Schema hints for overriding default behavior (keyed by TypeNode) */
  schemaHints?: WeakMap<ts.Node, { items?: unknown }>;
  /** Override for array items schema, propagated from wrapper types */
  arrayItemsOverride?: unknown;
}

/**
 * Interface for type formatters that convert TypeScript types to JSON Schema
 */
export interface TypeFormatter {
  /**
   * Check if this formatter can handle the given type
   */
  supportsType(type: ts.Type, context: GenerationContext): boolean;

  /**
   * Convert the type to JSON Schema
   */
  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition;
}

/**
 * Main schema generator class
 */
export interface SchemaGenerator {
  /**
   * Generate JSON Schema for a TypeScript type
   */
  generateSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
    options?: { widenLiterals?: boolean },
    schemaHints?: WeakMap<ts.Node, { items?: unknown }>,
  ): SchemaDefinition;

  /**
   * Generate schema from a synthetic TypeNode that doesn't resolve to a proper Type.
   * Used by transformers that create synthetic type structures programmatically.
   *
   * @param typeNode - Synthetic TypeNode to analyze
   * @param checker - TypeScript type checker
   * @param typeRegistry - Optional WeakMap of Node → Type for registered synthetic nodes
   * @param schemaHints - Optional WeakMap of Node → hints for overriding default behavior
   */
  generateSchemaFromSyntheticTypeNode(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    typeRegistry?: WeakMap<ts.Node, ts.Type>,
    schemaHints?: WeakMap<ts.Node, { items?: unknown }>,
  ): SchemaDefinition;
}
