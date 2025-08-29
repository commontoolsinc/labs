import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

export class ArrayFormatter implements TypeFormatter {
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
    // Just return the basic array structure
    // The element type will be handled recursively by the main generator
    return {
      type: "array",
      items: { type: "object", additionalProperties: true }, // Placeholder
    };
  }
}
