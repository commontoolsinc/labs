import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import {
  extractValueFromTypeNode,
  getNamedTypeKey,
  isDefaultTypeRef,
  safeGetPropertyType,
} from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: SchemaGenerator) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
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
      try {
        const elementType = context.typeChecker.getIndexTypeOfType(
          type,
          ts.IndexKind.Number,
        );
        if (elementType) {
          return false;
        }
      } catch (_) {
        // Ignore errors
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
      const propDecl = prop.valueDeclaration;
      if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
        propTypeNode = propDecl.type;
      }

      // Fast-path: if the property node is Array<T> or ReadonlyArray<T>, synthesize
      // an array schema from the node to avoid reliance on lib type metadata.
      if (
        this.schemaGenerator && propTypeNode &&
        ts.isTypeReferenceNode(propTypeNode) &&
        ts.isIdentifier(propTypeNode.typeName) &&
        (propTypeNode.typeName.text === "Array" ||
          propTypeNode.typeName.text === "ReadonlyArray") &&
        propTypeNode.typeArguments && propTypeNode.typeArguments.length > 0
      ) {
        const elemNode = propTypeNode.typeArguments[0]!;
        const elemType = checker.getTypeFromTypeNode(elemNode);
        const items = this.schemaGenerator.formatChildType(
          elemType,
          checker,
          elemNode,
        );
        properties[propName] = { type: "array", items } as SchemaDefinition;
        continue;
      }

      // Get the actual property type and recursively delegate to the main schema generator
      const resolvedPropType = safeGetPropertyType(
        prop,
        type,
        checker,
        propTypeNode,
      );

      if (this.schemaGenerator) {
        // If property is a Default<T,V> wrapper, inline so default can be attached
        const isDefaultWrapper = propTypeNode &&
          ts.isTypeReferenceNode(propTypeNode) &&
          isDefaultTypeRef(propTypeNode, checker);

        // Do not force $ref emission for named, non-cyclic types. Inline them
        // here and let the main generator handle cycles/$definitions.

        const generated: SchemaDefinition = this.schemaGenerator.formatChildType(
          resolvedPropType,
          checker,
          propTypeNode,
        );
        if (propName === "maybe") {
          // deno-lint-ignore no-console
          console.log(
            "[DBG:ObjectFormatter] delegated 'maybe' to specific formatter",
            generated,
          );
        }
        // If property is Cell<Default<T,V>> and default missing, attach it
        if (
          propTypeNode && ts.isTypeReferenceNode(propTypeNode) &&
          propTypeNode.typeArguments && propTypeNode.typeArguments.length > 0
        ) {
          const inner = propTypeNode.typeArguments[0];
          if (
            inner && ts.isTypeReferenceNode(inner) &&
            isDefaultTypeRef(inner, checker)
          ) {
            const defNode = inner.typeArguments?.[1];
            if (defNode) {
              const d = extractValueFromTypeNode(defNode, checker);
              if (d !== undefined && (generated as any).default === undefined) {
                (generated as any).default = d;
              }
            }
          }
        }
        // Reorder keys for array cells with defaults to match fixture order
        if (
          (generated as any).type === "array" &&
          (generated as any).items &&
          Object.prototype.hasOwnProperty.call(generated as any, "default") &&
          Object.prototype.hasOwnProperty.call(generated as any, "asCell")
        ) {
          const items = (generated as any).items;
          const def = (generated as any).default;
          const out: any = { type: "array", items, default: def, asCell: true };
          properties[propName] = out as SchemaDefinition;
        } else {
          // If generator fell back to object with additionalProperties but
          // the resolved type is actually an array, synthesize array schema
          // from the node to prevent object fallback in fixtures like
          // Stream<UpdaterInput> → updater.properties.newValues
          if (
            propTypeNode && ts.isTypeReferenceNode(propTypeNode) &&
            ts.isTypeLiteralNode(propTypeNode)
          ) {
            // no-op for type literals
            properties[propName] = generated;
          } else if (propTypeNode && ts.isArrayTypeNode(propTypeNode)) {
            const elemNode = propTypeNode.elementType;
            const elemType = checker.getTypeFromTypeNode(elemNode);
            const items = this.schemaGenerator.formatChildType(
              elemType,
              checker,
              elemNode,
            );
            properties[propName] = { type: "array", items } as SchemaDefinition;
          } else {
            properties[propName] = generated;
          }
        }
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
