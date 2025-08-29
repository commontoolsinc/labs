import ts from "typescript";
import { SchemaGenerator } from "./schema-generator.ts";

/**
 * Plugin function that matches the existing typeToJsonSchema signature
 * This allows our new system to be a drop-in replacement
 */
export function createSchemaTransformerV2(): (
  type: ts.Type,
  checker: ts.TypeChecker,
  typeArg?: ts.TypeNode,
) => any {
  const generator = new SchemaGenerator();

  return (type: ts.Type, checker: ts.TypeChecker, typeArg?: ts.TypeNode) => {
    return generator.generateSchema(type, checker, typeArg);
  };
}

/**
 * Alternative export for direct usage
 */
export { SchemaGenerator };
export type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "./interface.ts";

