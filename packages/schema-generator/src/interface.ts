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
  definitionStack: Set<any>;
  /** Currently building these named types */
  inProgressNames: Set<string>;

  // Optional context
  /** Type node for additional context */
  typeNode?: ts.TypeNode;
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
  ): SchemaDefinition;
}
