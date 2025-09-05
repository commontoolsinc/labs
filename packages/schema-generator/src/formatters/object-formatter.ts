import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { safeGetPropertyType } from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Handle object types (interfaces, type literals, classes)
    return (type.flags & ts.TypeFlags.Object) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;

    // Special-case Date to a string with date-time format (match old behavior)
    if (type.symbol?.name === "Date" && type.symbol?.valueDeclaration) {
      // Check if this is the built-in Date type (not a user-defined type named "Date")
      const sourceFile = type.symbol.valueDeclaration.getSourceFile();

      if (
        sourceFile.fileName.includes("lib.") ||
        sourceFile.fileName.includes("typescript/lib") ||
        sourceFile.fileName.includes("ES2023.d.ts") ||
        sourceFile.fileName.includes("DOM.d.ts")
      ) {
        return { type: "string", format: "date-time" };
      }
    }

    // Do not early-return for empty object types. Instead, try to enumerate
    // properties via the checker to allow type literals to surface members.

    const properties: Record<string, SchemaDefinition> = {};
    const required: string[] = [];

    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const propName = prop.getName();
      if (propName.startsWith("__")) continue; // Skip internal properties

      const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      if (!isOptional) required.push(propName);

      let propTypeNode: ts.TypeNode | undefined;
      const propDecl = prop.valueDeclaration ??
        (prop.declarations?.[0] as ts.Declaration);
      if (propDecl) {
        if (
          ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)
        ) {
          if (propDecl.type) propTypeNode = propDecl.type as ts.TypeNode;
        }
      }

      // Get the actual property type and recursively delegate to the main schema generator
      const resolvedPropType = safeGetPropertyType(
        prop,
        type,
        checker,
        propTypeNode,
      );

      // Delegate to the main generator (specific formatters handle wrappers/defaults)
      const generated: SchemaDefinition = this.schemaGenerator.formatChildType(
        resolvedPropType,
        context,
        propTypeNode,
      );
      properties[propName] = generated;
    }

    const schema: SchemaDefinition = { type: "object", properties };
    if (required.length > 0) schema.required = required;

    return schema;
  }
}
