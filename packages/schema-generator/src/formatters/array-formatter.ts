import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { getArrayElementInfo } from "../type-utils.ts";

export class ArrayFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return !!getArrayElementInfo(type, context.typeChecker, context.typeNode);
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
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

    // Handle special cases for any[], unknown[], and never[] with JSON Schema shortcuts
    const elementFlags = info.elementType.flags;

    if (elementFlags & ts.TypeFlags.Any) {
      // any[] - allow any item type
      return { type: "array", items: true };
    }

    if (elementFlags & ts.TypeFlags.Unknown) {
      // unknown[] - reject all item types
      return { type: "array", items: false };
    }

    if (elementFlags & ts.TypeFlags.Never) {
      // never[] - allow no items (empty arrays only)
      return { type: "array", items: false };
    }

    const items = this.schemaGenerator.formatChildType(
      info.elementType,
      context,
      info.elementNode,
    );

    return { type: "array", items };
  }
}
