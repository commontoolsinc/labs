import ts from "typescript";
import { SchemaGenerator } from "./schema-generator.ts";
import type { SchemaHint } from "./interface.ts";

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
      options?: { widenLiterals?: boolean },
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
    ) {
      return generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
        typeRegistry,
        schemaHints,
        sourceFile,
      );
    },
  };
}

/**
 * Alternative export for direct usage
 */
export { SchemaGenerator };
export type { GenerationContext, TypeFormatter } from "./interface.ts";
export type { JSONSchemaObjMutable } from "@commonfabric/api";
