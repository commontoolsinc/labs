import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import {
  extractValueFromTypeNode,
  getArrayElementType,
  isDefaultTypeRef,
} from "../type-utils.ts";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, Default<T,V>)
 */
export class CommonToolsFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: any) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Handle Common Tools wrapper types
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;

      // Check for type references (Cell<T>, Stream<T>, Default<T,V>)
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        const targetSymbol = typeRef.target?.symbol;
        const aliasSymbol = (typeRef as any).aliasSymbol as
          | ts.Symbol
          | undefined;
        const name = (targetSymbol?.name ?? (aliasSymbol as any)?.name) as
          | string
          | undefined;
        if (name) {
          return name === "Cell" || name === "Stream" || name === "Default";
        }
      }
    }

    return false;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const checker = context.typeChecker;
    const objectType = type as ts.ObjectType;
    const typeRef = objectType as ts.TypeReference;
    const symbol = typeRef.target?.symbol;

    if (!symbol) {
      return { type: "object", additionalProperties: true };
    }

    const name = symbol.getName();

    switch (name) {
      case "Cell":
        return this.formatCellType(typeRef, checker, context);
      case "Stream":
        return this.formatStreamType(typeRef, checker, context);
      case "Default":
        return this.formatDefaultType(typeRef, checker, context);
      default:
        return { type: "object", additionalProperties: true };
    }
  }

  private formatCellType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    // Get the typeNode from context (like the old system did)
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = context.typeNode.typeArguments[0];
    }

    // Use the old system's approach: extract inner type AND pass typeNode for recursive processing
    // Do not unwrap Array<T> here; let downstream logic inspect array-ness
    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    if (this.schemaGenerator) {
      // Alias-aware array detection on the actual container argument
      const containerArg = (typeRef.typeArguments && typeRef.typeArguments[0])
        ? typeRef.typeArguments[0]
        : undefined;
      if (containerArg && containerArg.flags & ts.TypeFlags.Object) {
        const containerObj = containerArg as ts.ObjectType;
        const containerIsDefault =
          (containerObj.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
          ((containerArg as ts.TypeReference).target?.symbol?.name ===
            "Default");
        if (!containerIsDefault) {
          const elem = getArrayElementType(containerArg, checker, innerTypeNode);
          if (elem) {
            const items = this.schemaGenerator.formatChildType(
              elem,
              checker,
            );
            return { type: "array", items, asCell: true } as SchemaDefinition;
          }
        }
      }
      // Special-case: Cell<Default<T,V>> should preserve defaults from V
      const isDefault = !!(
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      );
      if (isDefault && innerTypeNode && ts.isTypeReferenceNode(innerTypeNode)) {
        const innerRef = innerType as ts.TypeReference;
        const args =
          (innerRef as any).aliasTypeArguments as ts.Type[] | undefined ??
            (innerRef as any).resolvedTypeArguments as ts.Type[] | undefined ??
            innerRef.typeArguments;
        const nodeArgs = innerTypeNode.typeArguments;
        const valueType = args?.[0];
        const defaultType = args?.[1];
        const valueNode = nodeArgs?.[0];
        const defaultNode = nodeArgs?.[1];
        if (valueType) {
          // If value is an array by node, synthesize array with items to avoid
          // any formatter fallback losing element shapes.
          let valueSchema: SchemaDefinition;
          if (valueNode && ts.isArrayTypeNode(valueNode)) {
            const elemNode = valueNode.elementType;
            const elemType = context.typeChecker.getTypeFromTypeNode(elemNode);
            const items = this.schemaGenerator.formatChildType(
              elemType,
              context.typeChecker,
              elemNode,
            );
            // Build in fixture order: type, items, default, then wrapper flag
            const out: any = { type: "array", items };
            // Attach default now to keep ordering
            if (defaultNode) {
              const d = extractValueFromTypeNode(defaultNode, checker);
              if (d !== undefined) out.default = d;
            }
            valueSchema = out as SchemaDefinition;
          } else {
            valueSchema = this.schemaGenerator.formatChildType(
              valueType,
              context.typeChecker,
              valueNode,
            );
          }
          if (defaultNode && !(valueSchema as any).default) {
            const extracted = extractValueFromTypeNode(defaultNode, checker);
            if (extracted !== undefined) {
              (valueSchema as any).default = extracted;
            }
          }
          // Guard: ensure default is preserved even if array synthesis path ran
          if ((valueSchema as any).default === undefined && defaultNode) {
            const d2 = extractValueFromTypeNode(defaultNode, checker);
            if (d2 !== undefined) (valueSchema as any).default = d2;
          }

          // Nullable default handling (T | null)
          if ((valueType.flags & ts.TypeFlags.Union) !== 0) {
            const union = valueType as ts.UnionType;
            const members = union.types ?? [] as ts.Type[];
            const hasNull = members.some((t) =>
              (t.flags & ts.TypeFlags.Null) !== 0
            );
            const nonNull = members.filter((t) =>
              (t.flags & ts.TypeFlags.Null) === 0
            );
            if (hasNull && nonNull.length === 1) {
              const nonNullSchema = this.schemaGenerator.generateSchema(
                nonNull[0]!,
                context.typeChecker,
                valueNode,
              );
              const out: any = {
                oneOf: [nonNullSchema, { type: "null" }],
                asCell: true,
              };
              if ((valueSchema as any).default !== undefined) {
                out.default = (valueSchema as any).default;
              }
              return out as SchemaDefinition;
            }
          }

          return { ...valueSchema, asCell: true } as SchemaDefinition;
        }
      }

      // Handle Cell<Array<T>> and Cell<T[]> based on node or checker
      if (innerTypeNode && ts.isArrayTypeNode(innerTypeNode)) {
        const elemNode = innerTypeNode.elementType;
        const elemType = checker.getTypeFromTypeNode(elemNode);
        const items = this.schemaGenerator.formatChildType(
          elemType,
          checker,
          elemNode,
        );
        const out: any = { type: "array", items, asCell: true };
        // Preserve default when Default<T[], V> is inside Cell
        if (
          innerTypeNode &&
          ts.isTypeReferenceNode(innerTypeNode) &&
          isDefaultTypeRef(innerTypeNode as ts.TypeReferenceNode, checker)
        ) {
          const defNode = (innerTypeNode as ts.TypeReferenceNode).typeArguments
            ?.[1];
          if (defNode) {
            const d = extractValueFromTypeNode(defNode, checker);
            if (d !== undefined) out.default = d;
          }
        }
        return out as SchemaDefinition;
      }
      const arrayElem = getArrayElementType(innerType, checker, innerTypeNode);
      if (arrayElem) {
        const items = this.schemaGenerator.formatChildType(
          arrayElem,
          checker,
        );
        return { type: "array", items, asCell: true } as SchemaDefinition;
      }

      const nodeDrivenType = innerTypeNode
        ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
        : innerType;
      const innerSchema = this.schemaGenerator.formatChildType(
        nodeDrivenType,
        context.typeChecker,
        innerTypeNode,
      );
      // Fallback: if inner node is Default<T,V>, attach default here too
      if (
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      ) {
        const defNode = innerTypeNode.typeArguments?.[1];
        if (defNode) {
          const d = extractValueFromTypeNode(defNode, checker);
          if (d !== undefined) (innerSchema as any).default = d;
        }
      }
      return { ...innerSchema, asCell: true };
    } else {
      // Fallback for when schemaGenerator is not available
      const innerSchema = this.createSimpleInnerSchema(
        innerType,
        context.typeChecker,
      );
      return { ...innerSchema, asCell: true };
    }
  }

  private formatStreamType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    // Mirror Cell<T> robustness: resolve via alias/resolved arguments and carry node
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = context.typeNode.typeArguments[0];
    }

    // Do not unwrap Array<T> here; let downstream logic inspect array-ness
    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    if (this.schemaGenerator) {
      const containerArg = (typeRef.typeArguments && typeRef.typeArguments[0])
        ? typeRef.typeArguments[0]
        : undefined;
      const containerArgIsCell = !!(
        containerArg && (containerArg.flags & ts.TypeFlags.Object) !== 0 &&
        ((containerArg as ts.ObjectType).objectFlags &
            ts.ObjectFlags.Reference) !== 0 &&
        ((containerArg as ts.TypeReference).target?.symbol?.name === "Cell")
      );
      if (containerArg && containerArg.flags & ts.TypeFlags.Object) {
        const containerObj = containerArg as ts.ObjectType;
        const containerIsDefault =
          (containerObj.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
          ((containerArg as ts.TypeReference).target?.symbol?.name ===
            "Default");
        if (!containerIsDefault) {
          const elem = getArrayElementType(containerArg, checker, innerTypeNode);
          if (elem) {
            const items = this.schemaGenerator.formatChildType(
              elem,
              checker,
            );
            return { type: "array", items, asStream: true };
          }
        }
      }
      // Special-case: Stream<Default<T,V>>
      const isDefault = !!(
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      );
      if (isDefault && innerTypeNode && ts.isTypeReferenceNode(innerTypeNode)) {
        const innerRef = innerType as ts.TypeReference;
        const args =
          (innerRef as any).aliasTypeArguments as ts.Type[] | undefined ??
            (innerRef as any).resolvedTypeArguments as ts.Type[] | undefined ??
            innerRef.typeArguments;
        const nodeArgs = innerTypeNode.typeArguments;
        const valueType = args?.[0];
        const defaultType = args?.[1];
        const valueNode = nodeArgs?.[0];
        const defaultNode = nodeArgs?.[1];
        if (valueType) {
          let valueSchema: SchemaDefinition;
          if (valueNode && ts.isArrayTypeNode(valueNode)) {
            const elemNode = valueNode.elementType;
            const elemType = context.typeChecker.getTypeFromTypeNode(elemNode);
            const items = this.schemaGenerator.formatChildType(
              elemType,
              context.typeChecker,
              elemNode,
            );
            valueSchema = { type: "array", items };
          } else {
            valueSchema = this.schemaGenerator.formatChildType(
              valueType,
              context.typeChecker,
              valueNode,
            );
          }
          let extracted: any = undefined;
          if (defaultNode) {
            extracted = extractValueFromTypeNode(defaultNode, checker);
          }
          if (extracted === undefined && defaultType) {
            extracted = this.extractValueFromType(defaultType, checker);
          }
          if (extracted !== undefined) (valueSchema as any).default = extracted;

          if ((valueType.flags & ts.TypeFlags.Union) !== 0) {
            const union = valueType as ts.UnionType;
            const members = union.types ?? [] as ts.Type[];
            const hasNull = members.some((t) =>
              (t.flags & ts.TypeFlags.Null) !== 0
            );
            const nonNull = members.filter((t) =>
              (t.flags & ts.TypeFlags.Null) === 0
            );
            if (hasNull && nonNull.length === 1) {
              const nonNullSchema = this.schemaGenerator.generateSchema(
                nonNull[0]!,
                context.typeChecker,
                valueNode,
              );
              const out: any = {
                oneOf: [nonNullSchema, { type: "null" }],
                asStream: true,
              };
              if ((valueSchema as any).default !== undefined) {
                out.default = (valueSchema as any).default;
              }
              return out as SchemaDefinition;
            }
          }

          // If Stream< Cell<T> >, ensure both flags where fixtures expect it
          if (
            valueNode && ts.isTypeReferenceNode(valueNode) &&
            valueNode.typeName && ts.isIdentifier(valueNode.typeName) &&
            valueNode.typeName.text === "Cell"
          ) {
            return {
              ...valueSchema,
              asCell: true,
              asStream: true,
            } as SchemaDefinition;
          }
          // Also detect alias-resolved Cell via type or container argument
          if (
            containerArgIsCell ||
            (valueType && (valueType.flags & ts.TypeFlags.Object) !== 0 &&
              ((valueType as ts.TypeReference).target?.symbol?.name === "Cell"))
          ) {
            return {
              ...valueSchema,
              asCell: true,
              asStream: true,
            } as SchemaDefinition;
          }
          return { ...valueSchema, asStream: true } as SchemaDefinition;
        }
      }

      // Handle Stream<Array<T>> and Stream<T[]>
      if (innerTypeNode && ts.isArrayTypeNode(innerTypeNode)) {
        const elemNode = innerTypeNode.elementType;
        const elemType = checker.getTypeFromTypeNode(elemNode);
        const items = this.schemaGenerator.formatChildType(
          elemType,
          checker,
          elemNode,
        );
        return { type: "array", items, asStream: true } as SchemaDefinition;
      }
      const arrElem = getArrayElementType(innerType, checker, innerTypeNode);
      if (arrElem) {
        const items = this.schemaGenerator.formatChildType(
          arrElem,
          checker,
        );
        return { type: "array", items, asStream: true } as SchemaDefinition;
      }

      const nodeDrivenType = innerTypeNode
        ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
        : innerType;
      const innerSchema = this.schemaGenerator.formatChildType(
        nodeDrivenType,
        context.typeChecker,
        innerTypeNode,
      );
      // Fallback: if inner node is Default<T,V>, attach default here too
      if (
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      ) {
        const defNode = innerTypeNode.typeArguments?.[1];
        if (defNode) {
          const d = extractValueFromTypeNode(defNode, checker);
          if (d !== undefined) (innerSchema as any).default = d;
        }
      }
      // If inner is Cell<T> ensure both flags (covers aliases where node isn't Cell)
      if (
        containerArgIsCell ||
        ((innerType.flags & ts.TypeFlags.Object) !== 0 &&
          ((innerType as ts.TypeReference).target?.symbol?.name === "Cell"))
      ) {
        return { ...innerSchema, asCell: true, asStream: true };
      }
      return { ...innerSchema, asStream: true };
    }

    const innerSchema = this.createSimpleInnerSchema(innerType, checker);
    return { ...innerSchema, asStream: true };
  }

  private formatDefaultType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    const typeArguments = (typeRef as any).aliasTypeArguments as
      | ts.Type[]
      | undefined ??
      (typeRef as any).resolvedTypeArguments as ts.Type[] | undefined ??
      typeRef.typeArguments;
    if (!typeArguments || typeArguments.length < 2) {
      return { type: "object", additionalProperties: true };
    }
    const valueType = typeArguments[0]!;
    const defaultType = typeArguments[1]!;

    // Attempt node-based extraction for defaults when possible
    let valueTypeNode: ts.TypeNode | undefined;
    let defaultTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length >= 2
    ) {
      valueTypeNode = context.typeNode.typeArguments[0];
      defaultTypeNode = context.typeNode.typeArguments[1];
    }

    const inlineIfRef = (schema: SchemaDefinition): SchemaDefinition => {
      const ref = schema && (schema as any).$ref as string | undefined;
      if (ref && ref.startsWith("#/definitions/") && context.definitions) {
        const name = ref.replace("#/definitions/", "");
        const def = context.definitions[name];
        if (def) return def;
      }
      return schema;
    };

    let valueSchema: SchemaDefinition;
    if (this.schemaGenerator) {
      // Prefer node-driven generation; explicitly handle arrays to avoid fallback
      if (valueTypeNode && ts.isArrayTypeNode(valueTypeNode)) {
        const elemNode = valueTypeNode.elementType;
        const elemType = context.typeChecker.getTypeFromTypeNode(elemNode);
        const itemsRaw = this.schemaGenerator.generateSchema(
          elemType,
          context.typeChecker,
          elemNode,
        );
        valueSchema = { type: "array", items: inlineIfRef(itemsRaw) };
      } else {
        // If not an ArrayTypeNode, detect arrays via type analysis
        const elemType = getArrayElementType(
          valueType,
          context.typeChecker,
          valueTypeNode,
        );
        if (elemType) {
          const itemsRaw = this.schemaGenerator.generateSchema(
            elemType,
            context.typeChecker,
          );
          valueSchema = { type: "array", items: inlineIfRef(itemsRaw) };
        } else {
          const nodeDrivenType = valueTypeNode
            ? context.typeChecker.getTypeFromTypeNode(valueTypeNode)
            : undefined;
          const effectiveType = nodeDrivenType ?? valueType;
          const raw = this.schemaGenerator.generateSchema(
            effectiveType,
            context.typeChecker,
            valueTypeNode,
          );
          valueSchema = inlineIfRef(raw);
        }
      }
    } else {
      valueSchema = this.createSimpleInnerSchema(valueType, checker);
    }

    // Prefer extracting default from the node to support arrays/tuples/objects
    let extracted: any = undefined;
    if (defaultTypeNode) {
      extracted = extractValueFromTypeNode(defaultTypeNode, checker);
    }
    if (extracted === undefined) {
      extracted = this.extractValueFromType(defaultType, checker);
    }
    if (extracted !== undefined) {
      (valueSchema as any).default = extracted;
    }

    // If the value type is a union with null, produce oneOf form consistently
    if ((valueType.flags & ts.TypeFlags.Union) !== 0 && this.schemaGenerator) {
      const union = valueType as ts.UnionType;
      const members = union.types ?? [] as ts.Type[];
      const hasNull = members.some((t) => (t.flags & ts.TypeFlags.Null) !== 0);
      const hasUndef = members.some((t) =>
        (t.flags & ts.TypeFlags.Undefined) !== 0
      );
      const nonNull = members.filter((t) =>
        (t.flags & ts.TypeFlags.Null) === 0
      );
      const nonUndef = members.filter((t) =>
        (t.flags & ts.TypeFlags.Undefined) === 0
      );
      if (hasNull && nonNull.length === 1) {
        const nonNullSchema = this.schemaGenerator.generateSchema(
          nonNull[0]!,
          context.typeChecker,
          valueTypeNode,
        );
        // Preserve default on the union wrapper
        const out: any = { oneOf: [nonNullSchema, { type: "null" }] };
        if ((valueSchema as any).default !== undefined) {
          out.default = (valueSchema as any).default;
        }
        return out as SchemaDefinition;
      } else if (hasUndef && nonUndef.length === 1) {
        // T | undefined -> just T; do not set default
        const s = this.schemaGenerator.generateSchema(
          nonUndef[0]!,
          context.typeChecker,
          valueTypeNode,
        );
        return inlineIfRef(s);
      }
    }

    return valueSchema;
  }

  /**
   * Get type argument at the specified index, handling both typeArguments and resolvedTypeArguments
   * This is the same logic as the old system's getTypeArgument function
   */
  private getTypeArgument(type: ts.Type, index: number): ts.Type | undefined {
    const typeRef = type as ts.TypeReference;

    const aliasArgs = (type as any).aliasTypeArguments as ts.Type[] | undefined;
    const resolvedArgs = (type as any).resolvedTypeArguments as
      | ts.Type[]
      | undefined;
    const directArgs = typeRef.typeArguments as ts.Type[] | undefined;

    let chosen: ts.Type | undefined = undefined;
    if (aliasArgs && aliasArgs.length > index) chosen = aliasArgs[index];
    if (!chosen && resolvedArgs && resolvedArgs.length > index) {
      chosen = resolvedArgs[index];
    }
    if (!chosen && directArgs && directArgs.length > index) {
      chosen = directArgs[index];
    }

    if (!chosen) return undefined;

    return chosen;
  }

  private createSimpleInnerSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): SchemaDefinition {
    // Simple fallback for inner types
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

  private createSimpleInnerSchemaFromNode(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
  ): SchemaDefinition {
    // Simple fallback for inner types from TypeNode
    // In the full implementation, this would delegate to the main generator
    if (ts.isLiteralTypeNode(node)) {
      if (ts.isStringLiteral(node.literal)) {
        return { type: "string" };
      }
      if (ts.isNumericLiteral(node.literal)) {
        return { type: "number" };
      }
      if (
        node.literal.kind === ts.SyntaxKind.TrueKeyword ||
        node.literal.kind === ts.SyntaxKind.FalseKeyword
      ) {
        return { type: "boolean" };
      }
    }

    // Default fallback
    return { type: "object", additionalProperties: true };
  }

  private extractValueFromType(type: ts.Type, checker: ts.TypeChecker): any {
    // Simple extraction of literal values from types
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as any).intrinsicName === "true";
    }

    // Default fallback
    return undefined;
  }
}
