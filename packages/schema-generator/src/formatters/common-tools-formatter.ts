import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import {
  extractValueFromTypeNode,
  getArrayElementInfo,
  isDefaultTypeRef,
} from "../type-utils.ts";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, Default<T,V>)
 */
export class CommonToolsFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: any) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Prefer node-driven detection to handle aliases where Default<T,V> erases to T
    const n = (context as any).typeNode as ts.TypeNode | undefined;
    if (n && ts.isTypeReferenceNode(n)) {
      const tn = n.typeName;
      if (ts.isIdentifier(tn)) {
        if (tn.text === "Cell" || tn.text === "Stream") return true;
      }
      // Default<T,V> may be an alias; use helper to detect
      if (isDefaultTypeRef(n, context.typeChecker)) return true;
    }

    // Fallback: detect by type identity when wrappers are interfaces/classes
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        const name = typeRef.target?.symbol?.name;
        if (name === "Cell" || name === "Stream" || name === "Default") {
          return true;
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
    // If node indicates Default<T,V> (even if type erases to Array/etc.),
    // delegate to Default handler. Node takes precedence for Default alias.
    const n = (context as any).typeNode as ts.TypeNode | undefined;

    if (n && ts.isTypeReferenceNode(n) && isDefaultTypeRef(n, checker)) {
      return this.formatDefaultType(typeRef, checker, context);
    }

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
    const isNamedTypeRef = (t: ts.Type, name: string): boolean =>
      !!(t && (t.flags & ts.TypeFlags.Object) !== 0 &&
        (((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) &&
        ((t as ts.TypeReference).target?.symbol?.name === name));

    const getContainerArg = (
      ref: ts.TypeReference,
      idx = 0,
    ): ts.Type | undefined =>
      (ref.typeArguments && ref.typeArguments.length > idx)
        ? ref.typeArguments[idx]
        : undefined;
    // Helper: if the context node is an alias like type CellArray<T> = Cell<T[]>,
    // detect and return the element node substituted with the actual argument.
    const getAliasArrayElementFromCell = (
      node: ts.TypeNode | undefined,
    ): ts.TypeNode | undefined => {
      if (!node || !ts.isTypeReferenceNode(node)) return undefined;
      // Walk alias chain up to a small depth to see if it resolves to Cell<T[]>
      let current: ts.TypeNode | undefined = node;
      let depth = 0;
      while (current && ts.isTypeReferenceNode(current) && depth < 5) {
        const sym = checker.getSymbolAtLocation(current.typeName);
        const decl = sym?.declarations?.[0];
        if (!decl || !ts.isTypeAliasDeclaration(decl)) break;
        const aliased = decl.type;
        if (ts.isTypeReferenceNode(aliased)) {
          if (
            ts.isIdentifier(aliased.typeName) &&
            aliased.typeName.text === "Cell"
          ) {
            const inner = aliased.typeArguments?.[0];
            if (inner && ts.isArrayTypeNode(inner)) {
              // Found pattern Cell<T[]>; return the actual type argument from usage
              return node.typeArguments?.[0];
            }
            return undefined;
          }
          // Follow the alias to the next reference
          current = aliased;
          depth++;
          continue;
        }
        // Parenthesized or other wrappers: try to unwrap
        if (ts.isParenthesizedTypeNode(aliased)) {
          current = aliased.type as ts.TypeNode;
          depth++;
          continue;
        }
        break;
      }
      return undefined;
    };
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
      // Alias like type CellArray<T> = Cell<T[]>; synthesize array from alias mapping
      const aliasElemNode = getAliasArrayElementFromCell(context.typeNode);
      if (aliasElemNode) {
        const elemType = checker.getTypeFromTypeNode(aliasElemNode);
        const items = this.schemaGenerator.formatChildType(
          elemType,
          checker,
          aliasElemNode,
        );
        return { type: "array", items, asCell: true } as SchemaDefinition;
      }
      // Alias-aware array detection on the actual container argument
      const containerArg = getContainerArg(typeRef, 0);
      // If the inner node syntactically refers to Default<...>, do NOT
      // short-circuit via array detection on the erased type. Let Default
      // formatting handle defaults and then array wrapping will be discovered
      // when formatting the inner value type.
      const innerLooksLikeDefault = !!(
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      );
      if (
        containerArg && !innerLooksLikeDefault &&
        !isNamedTypeRef(containerArg, "Default")
      ) {
        const info = getArrayElementInfo(containerArg, checker, innerTypeNode);
        if (info) {
          const items = this.schemaGenerator.formatChildType(
            info.elementType,
            checker,
            info.elementNode,
          );
          return { type: "array", items, asCell: true } as SchemaDefinition;
        }
      }
      // Default<T,V> is handled by its own formatter; delegate and add asCell at the end

      // Handle Cell<Array<T>> and Cell<T[]> using the shared helper, unless
      // the inner syntactically looks like Default<...>, in which case we must
      // preserve Default handling (including defaults) and allow array to be
      // detected within Default formatting.
      if (!innerLooksLikeDefault) {
        const arr = this.arrayItemsSchema(innerType, innerTypeNode, checker);
        if (arr) return { ...arr, asCell: true } as SchemaDefinition;
      }

      const nodeDrivenType = innerTypeNode
        ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
        : innerType;
      const innerSchema = this.schemaGenerator.formatChildType(
        nodeDrivenType,
        context.typeChecker,
        innerTypeNode,
      );
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
    const isNamedTypeRef = (t: ts.Type, name: string): boolean =>
      !!(t && (t.flags & ts.TypeFlags.Object) !== 0 &&
        (((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) &&
        ((t as ts.TypeReference).target?.symbol?.name === name));

    const getContainerArg = (
      ref: ts.TypeReference,
      idx = 0,
    ): ts.Type | undefined =>
      (ref.typeArguments && ref.typeArguments.length > idx)
        ? ref.typeArguments[idx]
        : undefined;
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
      const containerArg = getContainerArg(typeRef, 0);
      const containerArgIsCell =
        !!(containerArg && isNamedTypeRef(containerArg, "Cell"));
      const innerLooksLikeDefault = !!(
        innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
        isDefaultTypeRef(innerTypeNode, checker)
      );
      if (
        containerArg && !innerLooksLikeDefault &&
        !isNamedTypeRef(containerArg, "Default")
      ) {
        const info = getArrayElementInfo(containerArg, checker, innerTypeNode);
        if (info) {
          const items = this.schemaGenerator.formatChildType(
            info.elementType,
            checker,
            info.elementNode,
          );
          return { type: "array", items, asStream: true };
        }
      }
      // If Stream<Default<T,V>> is encountered, Default handles default/union. Just add flags.
      if (innerTypeNode && ts.isTypeReferenceNode(innerTypeNode)) {
        // If Stream< Cell<T> >, ensure both flags where fixtures expect it
        if (
          ts.isTypeReferenceNode(innerTypeNode) &&
          innerTypeNode.typeName && ts.isIdentifier(innerTypeNode.typeName) &&
          innerTypeNode.typeName.text === "Cell"
        ) {
          return {
            ...(this.schemaGenerator.formatChildType(
              innerType,
              context.typeChecker,
              innerTypeNode,
            ) as any),
            asCell: true,
            asStream: true,
          } as SchemaDefinition;
        }
        // Also detect alias-resolved Cell via type or container argument
        if (
          containerArgIsCell ||
          (innerType && (innerType.flags & ts.TypeFlags.Object) !== 0 &&
            ((innerType as ts.TypeReference).target?.symbol?.name === "Cell"))
        ) {
          return {
            ...(this.schemaGenerator.formatChildType(
              innerType,
              context.typeChecker,
              innerTypeNode,
            ) as any),
            asCell: true,
            asStream: true,
          } as SchemaDefinition;
        }
        return {
          ...(this.schemaGenerator.formatChildType(
            innerType,
            context.typeChecker,
            innerTypeNode,
          ) as any),
          asStream: true,
        } as SchemaDefinition;
      }

      // Handle Stream<Array<T>> and Stream<T[]>
      const arr = this.arrayItemsSchema(innerType, innerTypeNode, checker);
      if (arr) return { ...arr, asStream: true } as SchemaDefinition;

      const nodeDrivenType = innerTypeNode
        ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
        : innerType;
      const innerSchema = this.schemaGenerator.formatChildType(
        nodeDrivenType,
        context.typeChecker,
        innerTypeNode,
      );
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

  private arrayItemsSchema(
    valueType: ts.Type,
    valueNode: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
  ): SchemaDefinition | undefined {
    if (!this.schemaGenerator) return undefined;
    const info = getArrayElementInfo(valueType, checker, valueNode);
    if (!info) return undefined;
    const items = this.schemaGenerator.formatChildType(
      info.elementType,
      checker,
      info.elementNode,
    );
    return { type: "array", items } as SchemaDefinition;
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

    // Attempt to recover erased type arguments from the node when Default<T,V>
    // is declared as a type alias to T in the environment (js-runtime).
    let valueType: ts.Type | undefined;
    let defaultType: ts.Type | undefined;

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

    if (typeArguments && typeArguments.length >= 2) {
      valueType = typeArguments[0]!;
      defaultType = typeArguments[1]!;
    } else if (valueTypeNode && defaultTypeNode) {
      // Erased alias path: derive types from nodes
      try {
        valueType = checker.getTypeFromTypeNode(valueTypeNode);
      } catch (_) {
        valueType = undefined;
      }
      try {
        defaultType = checker.getTypeFromTypeNode(defaultTypeNode);
      } catch (_) {
        defaultType = undefined;
      }
    }
    if (!valueType || !defaultType) {
      return { type: "object", additionalProperties: true };
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
        const itemsRaw = this.schemaGenerator.formatChildType(
          elemType,
          context.typeChecker,
          elemNode,
        );
        valueSchema = { type: "array", items: inlineIfRef(itemsRaw) };
      } else {
        // If not an ArrayTypeNode, detect arrays via type analysis
        const elemInfo = getArrayElementInfo(
          valueType,
          context.typeChecker,
          valueTypeNode,
        );
        if (elemInfo) {
          const itemsRaw = this.schemaGenerator.formatChildType(
            elemInfo.elementType,
            context.typeChecker,
            elemInfo.elementNode,
          );
          valueSchema = { type: "array", items: inlineIfRef(itemsRaw) };
        } else {
          // Try to use node-driven type first; if that still results in a
          // generic object fallback, synthesize directly from the node to
          // mirror old-system behavior under alias erasure.
          if (valueTypeNode) {
            try {
              const nodeType = context.typeChecker.getTypeFromTypeNode(
                valueTypeNode,
              );
              const raw = this.schemaGenerator.formatChildType(
                nodeType,
                context.typeChecker,
                valueTypeNode,
              );
              const inlined = inlineIfRef(raw);
              // If we got a generic fallback, keep it - tests will tell us if we need something better
              valueSchema = inlined;
            } catch (_) {
              // Fallback to generic schema if generation fails
              valueSchema = { type: "object", additionalProperties: true };
            }
          } else {
            const raw = this.schemaGenerator.formatChildType(
              valueType,
              context.typeChecker,
              valueTypeNode,
            );
            valueSchema = inlineIfRef(raw);
          }
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

    // If the value type is a union with null, produce oneOf form consistently.
    // Prefer syntax-driven detection first (valueTypeNode) to handle cases where
    // the checker folds away `null` in minimal program environments.
    if (
      this.schemaGenerator && valueTypeNode && ts.isUnionTypeNode(valueTypeNode)
    ) {
      const parts = valueTypeNode.types ?? [] as ts.TypeNode[];
      const isNullNode = (p: ts.TypeNode) =>
        p.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isLiteralTypeNode(p) &&
          p.literal.kind === ts.SyntaxKind.NullKeyword);
      const hasNullNode = parts.some(isNullNode);
      const nonNullNodes = parts.filter((p) => !isNullNode(p));
      if (hasNullNode && nonNullNodes.length === 1) {
        const nn = nonNullNodes[0]!;
        const nnType = context.typeChecker.getTypeFromTypeNode(nn);
        const nnSchema = this.schemaGenerator.generateSchema(
          nnType,
          context.typeChecker,
          nn,
        );
        const out: any = { oneOf: [{ type: "null" }, nnSchema] };
        if ((valueSchema as any).default !== undefined) {
          out.default = (valueSchema as any).default;
        }
        return out as SchemaDefinition;
      }
    }

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
