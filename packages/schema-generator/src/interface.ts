import type ts from "typescript";

/**
 * JSON Schema object type
 */
export interface SchemaDefinition {
  type?: string;
  properties?: Record<string, SchemaDefinition>;
  required?: string[];
  items?: SchemaDefinition;
  additionalProperties?: boolean | SchemaDefinition;
  $ref?: string;
  $schema?: string;
  definitions?: Record<string, SchemaDefinition>;
  [key: string]: any;
}

/**
 * Context passed to formatters during schema generation
 */
export interface FormatterContext {
  /** The root schema being generated */
  rootSchema: SchemaDefinition;
  /** Types that have been seen to detect cycles */
  seenTypes: Set<ts.Type>;
  /** TypeScript type checker */
  typeChecker: ts.TypeChecker;
  /** Current recursion depth */
  depth: number;
  /** Maximum allowed recursion depth */
  maxDepth: number;
  /** Definitions for cyclic types */
  definitions: Record<string, SchemaDefinition>;
  /** Types currently being processed (for cycle detection) */
  definitionStack: Set<ts.Type>;
  /** Names currently being processed */
  inProgressNames: Set<string>;
  /** References that have been emitted */
  emittedRefs: Set<string>;
  /** Type node for generic type extraction */
  typeNode?: ts.TypeNode;
}

/**
 * Interface for type formatters that convert TypeScript types to JSON Schema
 */
export interface TypeFormatter {
  /**
   * Check if this formatter can handle the given type
   */
  supportsType(type: ts.Type, context: FormatterContext): boolean;

  /**
   * Convert the type to JSON Schema
   */
  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition;
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
