import ts from "typescript";
import { SchemaGenerator } from "./schema-generator.ts";
import type { SchemaGenerationOptions, SchemaHint } from "./interface.ts";

/**
 * Plugin function that creates a schema transformer with access to both
 * Type-based and synthetic TypeNode-based schema generation
 */
export function createSchemaTransformerV2() {
  const generator = new SchemaGenerator();

  return {
    generateSchema(
      type: ts.Type,
      checker: ts.TypeChecker,
      typeArg?: ts.TypeNode,
      options?: SchemaGenerationOptions,
      schemaHints?: WeakMap<ts.Node, SchemaHint>,
      sourceFile?: ts.SourceFile,
      typeRegistry?: WeakMap<ts.Node, ts.Type>,
    ) {
      return generator.generateSchema(
        type,
        checker,
        typeArg,
        options,
        schemaHints,
        sourceFile,
        typeRegistry,
      );
    },

    generateSchemaFromSyntheticTypeNode(
      typeNode: ts.TypeNode,
      checker: ts.TypeChecker,
      typeRegistry?: WeakMap<ts.Node, ts.Type>,
      schemaHints?: WeakMap<ts.Node, SchemaHint>,
      sourceFile?: ts.SourceFile,
      options?: SchemaGenerationOptions,
    ) {
      return generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
        typeRegistry,
        schemaHints,
        sourceFile,
        options,
      );
    },
  };
}

/**
 * Alternative export for direct usage
 */
export { SchemaGenerator };
export type {
  GenerationContext,
  SchemaGenerationOptions,
  TypeFormatter,
  WriterSourceIdentity,
} from "./interface.ts";
export type { MutableJSONSchemaObj } from "@commonfabric/api";
