import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

export class ArrayFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: SchemaGenerator) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Check if this is an Array type
    if (type.symbol?.name === "Array") {
      return true;
    }

    // Check if this type has a numeric index signature (T[])
    const indexType = context.typeChecker.getIndexTypeOfType(
      type,
      ts.IndexKind.Number,
    );
    if (indexType) {
      return true;
    }

    return false;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    // Resolve element type via index signature when possible
    try {
      const elementType = context.typeChecker.getIndexTypeOfType(
        type,
        ts.IndexKind.Number,
      );
      if (elementType && this.schemaGenerator) {
        const items = this.schemaGenerator.generateSchema(
          elementType,
          context.typeChecker,
        );
        return { type: "array", items };
      }
    } catch (_) {
      // ignore
    }
    return {
      type: "array",
      items: { type: "object", additionalProperties: true },
    };
  }
}
