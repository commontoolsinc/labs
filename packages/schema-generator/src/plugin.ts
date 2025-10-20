import ts from "typescript";
import { SchemaGenerator } from "./schema-generator.ts";

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
    ) {
      return generator.generateSchema(type, checker, typeArg);
    },

    generateSchemaFromSyntheticTypeNode(
      typeNode: ts.TypeNode,
      checker: ts.TypeChecker,
      typeRegistry?: WeakMap<ts.Node, ts.Type>,
    ) {
      return generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
        typeRegistry,
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
  SchemaDefinition,
  TypeFormatter,
} from "./interface.ts";
