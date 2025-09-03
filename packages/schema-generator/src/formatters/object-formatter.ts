import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { getArrayElementInfo, safeGetPropertyType } from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: SchemaGenerator) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Treat array-like as non-object here so ArrayFormatter handles it
    if (getArrayElementInfo(type, context.typeChecker, context.typeNode)) {
      return false;
    }

    // Handle object types
    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const objectType = type as ts.ObjectType;

      // Allow named TypeReference interfaces/classes, but still skip Array/ReadonlyArray
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const ref = objectType as ts.TypeReference;
        const targetName = ref.target?.symbol?.name;
        if (targetName === "Array" || targetName === "ReadonlyArray") {
          return false;
        }
        // Handle other references (interfaces/classes) as objects here
        return true;
      }

      // Skip array-like types - let ArrayFormatter handle them
      if (getArrayElementInfo(type, context.typeChecker, context.typeNode)) {
        return false;
      }

      return true;
    }

    return false;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const checker = context.typeChecker;

    // Special-case Date to a string with date-time format
    try {
      const typeText = checker.typeToString(type);
      if (typeText === "Date") {
        return { type: "string", format: "date-time" };
      }
    } catch (_) {
      // ignore
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
      const propDecl = (prop.valueDeclaration ?? (prop.declarations?.[0] as any));
      if (propDecl) {
        if (ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)) {
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

      if (this.schemaGenerator) {
        // Delegate to the main generator (specific formatters handle wrappers/defaults)
        const generated: SchemaDefinition = this.schemaGenerator.formatChildType(
          resolvedPropType,
          checker,
          propTypeNode,
        );
        properties[propName] = generated;
      } else {
        // Fallback for when schemaGenerator is not available
        properties[propName] = this.createSimplePropertySchema(
          resolvedPropType,
          checker,
        );
      }
    }

    const schema: SchemaDefinition = { type: "object", properties };
    if (required.length > 0) schema.required = required;

    return schema;
  }

  private createSimplePropertySchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): SchemaDefinition {
    // Simple fallback for property types
    // In the full implementation, this would delegate to the main generator
    if (type.flags & ts.TypeFlags.String) {
      return { type: "string" };
    }
    if (type.flags & ts.TypeFlags.Number) {
      return { type: "number" };
    }
    if (type.flags & ts.TypeFlags.Boolean) {
      return { type: "boolean" };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return { type: "string", enum: ["undefined"] };
    }

    // Default fallback
    return { type: "object", additionalProperties: true };
  }
}
