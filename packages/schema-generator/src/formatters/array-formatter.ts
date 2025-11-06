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

    // If elementType is 'any' but we have a concrete TypeNode, directly use the node
    // This handles cases where TypeScript widened the type but we have precise node info
    if ((elementFlags & ts.TypeFlags.Any) && info.elementNode) {
      const nodeType = context.typeChecker.getTypeFromTypeNode(info.elementNode);

      // For synthetic nodes (pos===-1), use generateSchemaFromSyntheticTypeNode
      // which has proper handling for keyword types
      if (info.elementNode.pos === -1 && info.elementNode.end === -1) {
        let items = this.schemaGenerator.generateSchemaFromSyntheticTypeNode(
          info.elementNode,
          context.typeChecker,
        );

        // Strip the $schema and $defs fields - we only want the inner schema
        // since this is nested within a parent schema
        if (typeof items === "object" && items !== null && "$schema" in items) {
          const { $schema, $defs, ...innerSchema} = items as Record<string, unknown>;
          items = innerSchema;
        }

        return { type: "array", items };
      }

      if (!(nodeType.flags & ts.TypeFlags.Any)) {
        // Use the more precise type from the node
        const items = this.schemaGenerator.formatChildType(
          nodeType,
          context,
          info.elementNode,
        );
        return { type: "array", items };
      }
    }

    if (elementFlags & ts.TypeFlags.Any) {
      // any[] - allow any item type
      return { type: "array", items: true };
    }

    if (elementFlags & ts.TypeFlags.Unknown) {
      // unknown[] - allow any item type (type safety at compile time)
      return { type: "array", items: true };
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
