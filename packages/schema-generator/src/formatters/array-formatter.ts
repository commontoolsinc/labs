import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { getArrayElementInfo } from "../type-utils.ts";

export class ArrayFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: FormatterContext): boolean {
    return !!getArrayElementInfo(type, context.typeChecker, context.typeNode);
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const info = getArrayElementInfo(
      type,
      context.typeChecker,
      context.typeNode,
    );

    if (!info) {
      throw new Error(
        "ArrayFormatter.formatType called but getArrayElementInfo returned null - this indicates a bug in supportsType logic",
      );
    }

    if (!info.elementType) {
      throw new Error(
        "ArrayFormatter received malformed array element info with missing elementType",
      );
    }

    const items = this.schemaGenerator.generateSchema(
      info.elementType,
      context.typeChecker,
      info.elementNode,
    );

    return { type: "array", items };
  }
}
