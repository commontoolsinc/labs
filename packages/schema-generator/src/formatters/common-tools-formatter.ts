import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import {
  getArrayElementInfo,
  isDefaultTypeRef,
  safeGetTypeFromTypeNode,
  TypeWithInternals,
} from "../type-utils.ts";
import { SchemaGenerator } from "../plugin.ts";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, Default<T,V>)
 */
export class CommonToolsFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {
    if (!schemaGenerator) {
      throw new Error(
        "CommonToolsFormatter requires a schemaGenerator instance",
      );
    }
  }

  private isNamedTypeRef(type: ts.Type, name: string): boolean {
    return !!(type && (type.flags & ts.TypeFlags.Object) !== 0 &&
      (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !==
        0) &&
      ((type as ts.TypeReference).target?.symbol?.name === name));
  }

  private getContainerArg(
    typeRef: ts.TypeReference,
    index = 0,
  ): ts.Type | undefined {
    return (typeRef.typeArguments && typeRef.typeArguments.length > index)
      ? typeRef.typeArguments[index]
      : undefined;
  }

  private getInnerTypeNode(
    context: GenerationContext,
  ): ts.TypeNode | undefined {
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length > 0
    ) {
      return context.typeNode.typeArguments[0];
    }
    return undefined;
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Prefer node-driven detection to handle aliases where Default<T,V> erases to T
    const n = context.typeNode;
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

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;
    const n = context.typeNode;

    // First priority: check if node indicates Default<T,V> (handles type aliases)
    if (n && ts.isTypeReferenceNode(n) && isDefaultTypeRef(n, checker)) {
      // For type aliases, create a mock typeRef for processing
      const mockTypeRef = {
        typeArguments: undefined,
      } as unknown as ts.TypeReference;
      return this.formatDefaultType(mockTypeRef, checker, context);
    }

    // Type safety: ensure we have an object type with reference for interface cases
    if (!(type.flags & ts.TypeFlags.Object)) {
      return { type: "object", additionalProperties: true };
    }

    const objectType = type as ts.ObjectType;
    if (!(objectType.objectFlags & ts.ObjectFlags.Reference)) {
      return { type: "object", additionalProperties: true };
    }

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
    context: GenerationContext,
  ): SchemaDefinition {
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
    const innerTypeNode = this.getInnerTypeNode(context);

    // Use the old system's approach: extract inner type AND pass typeNode for recursive processing
    // Do not unwrap Array<T> here; let downstream logic inspect array-ness
    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    // Alias like type CellArray<T> = Cell<T[]>; synthesize array from alias mapping
    const aliasElemNode = getAliasArrayElementFromCell(context.typeNode);
    if (aliasElemNode) {
      const elemType = checker.getTypeFromTypeNode(aliasElemNode);
      const items = this.schemaGenerator.formatChildType(
        elemType,
        context,
        aliasElemNode,
      );
      return { type: "array", items, asCell: true } as SchemaDefinition;
    }
    // Alias-aware array detection on the actual container argument
    const containerArg = this.getContainerArg(typeRef, 0);
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
      !this.isNamedTypeRef(containerArg, "Default")
    ) {
      const arr = this.arrayItemsSchema(containerArg, innerTypeNode, context);
      if (arr) return { ...arr, asCell: true } as SchemaDefinition;
    }
    // Default<T,V> is handled by its own formatter; delegate and add asCell at the end

    // Handle Cell<Array<T>> and Cell<T[]> using the shared helper, unless
    // the inner syntactically looks like Default<...>, in which case we must
    // preserve Default handling (including defaults) and allow array to be
    // detected within Default formatting.
    if (!innerLooksLikeDefault) {
      const arr = this.arrayItemsSchema(innerType, innerTypeNode, context);
      if (arr) return { ...arr, asCell: true } as SchemaDefinition;
    }

    const nodeDrivenType = innerTypeNode
      ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
      : innerType;
    const innerSchema = this.schemaGenerator.formatChildType(
      nodeDrivenType,
      context,
      innerTypeNode,
    );
    return { ...innerSchema, asCell: true };
  }

  private formatStreamType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): SchemaDefinition {
    // Centralize Cell detection and Stream flag application
    const isCellNode = (node?: ts.TypeNode): boolean => {
      return !!(
        node && ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === "Cell"
      );
    };
    const isCellType = (t: ts.Type): boolean => {
      return !!(
        (t.flags & ts.TypeFlags.Object) !== 0 &&
        ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
        ((t as ts.TypeReference).target?.symbol?.name === "Cell")
      );
    };
    const withStreamFlags = (
      base: SchemaDefinition,
      innerT: ts.Type,
      innerN: ts.TypeNode | undefined,
      containerArgIsCell: boolean,
    ): SchemaDefinition => {
      const innerIsCell = containerArgIsCell || isCellNode(innerN) ||
        isCellType(innerT);
      return innerIsCell
        ? { ...base, asCell: true, asStream: true }
        : { ...base, asStream: true };
    };
    // Mirror Cell<T> robustness: resolve via alias/resolved arguments and carry node
    const innerTypeNode = this.getInnerTypeNode(context);

    // Do not unwrap Array<T> here; let downstream logic inspect array-ness
    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    // Process Stream type
    const containerArg = this.getContainerArg(typeRef, 0);
    const containerArgIsCell =
      !!(containerArg && this.isNamedTypeRef(containerArg, "Cell"));
    const innerLooksLikeDefault = !!(
      innerTypeNode && ts.isTypeReferenceNode(innerTypeNode) &&
      isDefaultTypeRef(innerTypeNode, checker)
    );
    if (
      containerArg && !innerLooksLikeDefault &&
      !this.isNamedTypeRef(containerArg, "Default")
    ) {
      const arr = this.arrayItemsSchema(containerArg, innerTypeNode, context);
      if (arr) return { ...arr, asStream: true };
    }
    // If Stream<Default<T,V>> is encountered, Default handles default/union.
    // Generate child schema and apply Stream/Cell flags based on inner shape.
    if (innerTypeNode && ts.isTypeReferenceNode(innerTypeNode)) {
      const child = this.schemaGenerator.formatChildType(
        innerType,
        context,
        innerTypeNode,
      );
      return withStreamFlags(child, innerType, innerTypeNode, containerArgIsCell);
    }

    // Handle Stream<Array<T>> and Stream<T[]>
    const arr = this.arrayItemsSchema(innerType, innerTypeNode, context);
    if (arr) return { ...arr, asStream: true } as SchemaDefinition;

    const nodeDrivenType = innerTypeNode
      ? context.typeChecker.getTypeFromTypeNode(innerTypeNode)
      : innerType;
    const innerSchema = this.schemaGenerator.formatChildType(
      nodeDrivenType,
      context,
      innerTypeNode,
    );
    return withStreamFlags(
      innerSchema,
      innerType,
      innerTypeNode,
      containerArgIsCell,
    );
  }

  private arrayItemsSchema(
    valueType: ts.Type,
    valueNode: ts.TypeNode | undefined,
    context: GenerationContext,
  ): SchemaDefinition | undefined {
    const info = getArrayElementInfo(valueType, context.typeChecker, valueNode);
    if (!info) return undefined;
    const items = this.schemaGenerator.formatChildType(
      info.elementType,
      context,
      info.elementNode,
    );
    return { type: "array", items } as SchemaDefinition;
  }

  private extractDefaultTypeArguments(
    typeRef: ts.TypeReference,
    context: GenerationContext,
    checker: ts.TypeChecker,
  ): {
    valueType: ts.Type;
    defaultType: ts.Type;
    valueTypeNode?: ts.TypeNode;
    defaultTypeNode?: ts.TypeNode;
  } | null {
    let valueType: ts.Type | undefined;
    let defaultType: ts.Type | undefined;
    let valueTypeNode: ts.TypeNode | undefined;
    let defaultTypeNode: ts.TypeNode | undefined;

    // First priority: extract from node syntax (handles type aliases)
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length >= 2
    ) {
      valueTypeNode = context.typeNode.typeArguments[0];
      defaultTypeNode = context.typeNode.typeArguments[1];

      // Always derive types from nodes for type aliases
      if (valueTypeNode) {
        valueType = safeGetTypeFromTypeNode(
          checker,
          valueTypeNode,
          "Default<T,V> value type",
        );
      }
      if (defaultTypeNode) {
        defaultType = safeGetTypeFromTypeNode(
          checker,
          defaultTypeNode,
          "Default<T,V> default type",
        );
      }
    }

    // Second priority: try to extract from resolved type arguments (handles interfaces)
    if (!valueType || !defaultType) {
      const typeArguments = (typeRef as TypeWithInternals).aliasTypeArguments ??
        (typeRef as TypeWithInternals).resolvedTypeArguments ??
        typeRef.typeArguments;

      if (typeArguments && typeArguments.length >= 2) {
        valueType = typeArguments[0]!;
        defaultType = typeArguments[1]!;
      }
    }

    if (!valueType || !defaultType) {
      return null;
    }

    const result: {
      valueType: ts.Type;
      defaultType: ts.Type;
      valueTypeNode?: ts.TypeNode;
      defaultTypeNode?: ts.TypeNode;
    } = {
      valueType,
      defaultType,
    };

    if (valueTypeNode) {
      result.valueTypeNode = valueTypeNode;
    }
    if (defaultTypeNode) {
      result.defaultTypeNode = defaultTypeNode;
    }

    return result;
  }

  private inlineIfRef(
    schema: SchemaDefinition,
    context: GenerationContext,
  ): SchemaDefinition {
    /*
     * Draft-07 $ref constraint:
     * In JSON Schema draft-07, when a schema object contains $ref, validators
     * ignore all sibling keywords of that object. To attach keywords like
     * `default` (e.g., from Default<T,V>) to the effective schema, we inline
     * local #/definitions targets here. Only the immediate $ref is inlined;
     * we do not recursively inline nested $refs to avoid expanding cycles.
     */
    const ref = schema && (schema as any).$ref as string | undefined;
    if (ref && ref.startsWith("#/definitions/") && context.definitions) {
      const name = ref.replace("#/definitions/", "");
      const def = context.definitions[name];
      if (def) return def;
    }
    return schema;
  }

  private generateValueSchema(
    valueType: ts.Type,
    valueTypeNode: ts.TypeNode | undefined,
    context: GenerationContext,
  ): SchemaDefinition {
    // Handle array types first
    if (valueTypeNode && ts.isArrayTypeNode(valueTypeNode)) {
      const elemNode = valueTypeNode.elementType;
      const elemType = context.typeChecker.getTypeFromTypeNode(elemNode);
      const itemsRaw = this.schemaGenerator.formatChildType(
        elemType,
        context,
        elemNode,
      );
      return { type: "array", items: this.inlineIfRef(itemsRaw, context) };
    }

    // Detect arrays via type analysis
    const elemInfo = getArrayElementInfo(
      valueType,
      context.typeChecker,
      valueTypeNode,
    );
    if (elemInfo) {
      const itemsRaw = this.schemaGenerator.formatChildType(
        elemInfo.elementType,
        context,
        elemInfo.elementNode,
      );
      return { type: "array", items: this.inlineIfRef(itemsRaw, context) };
    }

    // Generate schema for other types
    if (valueTypeNode) {
      try {
        const nodeType = context.typeChecker.getTypeFromTypeNode(valueTypeNode);
        const raw = this.schemaGenerator.formatChildType(
          nodeType,
          context,
          valueTypeNode,
        );
        return this.inlineIfRef(raw, context);
      } catch (error) {
        console.warn(
          "Failed to generate schema for Default<T,V> value type:",
          error,
        );
        return { type: "object", additionalProperties: true };
      }
    } else {
      const raw = this.schemaGenerator.formatChildType(
        valueType,
        context,
        valueTypeNode,
      );
      return this.inlineIfRef(raw, context);
    }
  }

  private extractDefaultValue(
    defaultType: ts.Type,
    defaultTypeNode: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
  ): any {
    // Try complex extraction first (from node)
    if (defaultTypeNode) {
      const complex = this.extractComplexDefaultValue(defaultTypeNode, checker);
      if (complex !== undefined) {
        return complex;
      }
    }

    // Fall back to literal extraction (from type)
    return this.extractLiteralDefaultValue(defaultType, checker);
  }

  private processDefaultUnionTypes(
    valueType: ts.Type,
    valueTypeNode: ts.TypeNode | undefined,
    valueSchema: SchemaDefinition,
    context: GenerationContext,
  ): SchemaDefinition {
    // Handle node-based union types (syntax-driven detection)
    if (valueTypeNode && ts.isUnionTypeNode(valueTypeNode)) {
      const result = this.processNodeBasedUnion(
        valueTypeNode,
        valueSchema,
        context,
      );
      if (result) return result;
    }

    // Handle type-based union types
    if ((valueType.flags & ts.TypeFlags.Union) !== 0) {
      const result = this.processTypeBasedUnion(
        valueType,
        valueTypeNode,
        valueSchema,
        context,
      );
      if (result) return result;
    }

    return valueSchema;
  }

  private processNodeBasedUnion(
    unionNode: ts.UnionTypeNode,
    valueSchema: SchemaDefinition,
    context: GenerationContext,
  ): SchemaDefinition | null {
    const parts = unionNode.types ?? [] as ts.TypeNode[];
    const isNullNode = (p: ts.TypeNode) =>
      p.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isLiteralTypeNode(p) && p.literal.kind === ts.SyntaxKind.NullKeyword);

    const hasNullNode = parts.some(isNullNode);
    const nonNullNodes = parts.filter((p) => !isNullNode(p));

    if (hasNullNode && nonNullNodes.length === 1) {
      const nn = nonNullNodes[0]!;
      const nnType = context.typeChecker.getTypeFromTypeNode(nn);
      const nnSchema = this.schemaGenerator.formatChildType(
        nnType,
        context,
        nn,
      );

      const out: any = { oneOf: [{ type: "null" }, nnSchema] };
      if ((valueSchema as any).default !== undefined) {
        out.default = (valueSchema as any).default;
      }
      return out as SchemaDefinition;
    }

    return null;
  }

  private processTypeBasedUnion(
    valueType: ts.Type,
    valueTypeNode: ts.TypeNode | undefined,
    valueSchema: SchemaDefinition,
    context: GenerationContext,
  ): SchemaDefinition | null {
    const union = valueType as ts.UnionType;
    const members = union.types ?? [] as ts.Type[];

    const hasNull = members.some((t) => (t.flags & ts.TypeFlags.Null) !== 0);
    const hasUndef = members.some((t) =>
      (t.flags & ts.TypeFlags.Undefined) !== 0
    );
    const nonNull = members.filter((t) => (t.flags & ts.TypeFlags.Null) === 0);
    const nonUndef = members.filter((t) =>
      (t.flags & ts.TypeFlags.Undefined) === 0
    );

    if (hasNull && nonNull.length === 1) {
      const nonNullSchema = this.schemaGenerator.formatChildType(
        nonNull[0]!,
        context,
        valueTypeNode,
      );

      const out: any = { oneOf: [nonNullSchema, { type: "null" }] };
      if ((valueSchema as any).default !== undefined) {
        out.default = (valueSchema as any).default;
      }
      return out as SchemaDefinition;
    } else if (hasUndef && nonUndef.length === 1) {
      const s = this.schemaGenerator.formatChildType(
        nonUndef[0]!,
        context,
        valueTypeNode,
      );
      return this.inlineIfRef(s, context);
    }

    return null;
  }

  private formatDefaultType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): SchemaDefinition {
    const typeArgs = this.extractDefaultTypeArguments(
      typeRef,
      context,
      checker,
    );
    if (!typeArgs) {
      return { type: "object", additionalProperties: true };
    }

    const { valueType, defaultType, valueTypeNode, defaultTypeNode } = typeArgs;

    const valueSchema = this.generateValueSchema(
      valueType,
      valueTypeNode,
      context,
    );

    const defaultValue = this.extractDefaultValue(
      defaultType,
      defaultTypeNode,
      checker,
    );

    if (defaultValue !== undefined) {
      (valueSchema as any).default = defaultValue;
    }

    return this.processDefaultUnionTypes(
      valueType,
      valueTypeNode,
      valueSchema,
      context,
    );
  }

  /**
   * Get type argument at the specified index, handling both typeArguments and resolvedTypeArguments
   * This is the same logic as the old system's getTypeArgument function
   */
  private getTypeArgument(type: ts.Type, index: number): ts.Type | undefined {
    const typeRef = type as ts.TypeReference;

    const aliasArgs = (type as TypeWithInternals).aliasTypeArguments;
    const resolvedArgs = (type as TypeWithInternals).resolvedTypeArguments;
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

  private extractLiteralDefaultValue(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): any {
    // Simple extraction of literal values (string, number, boolean) from types as fallback
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as TypeWithInternals).intrinsicName === "true";
    }

    // Default fallback
    return undefined;
  }

  /**
   * Extract complex default values (objects, arrays, tuples) from AST syntax for Default<T,V> processing
   */
  private extractComplexDefaultValue(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
  ): any {
    if (ts.isLiteralTypeNode(node)) {
      const lit = node.literal;
      if (ts.isStringLiteral(lit)) return lit.text;
      if (ts.isNumericLiteral(lit)) return Number(lit.text);
      if (lit.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (lit.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (lit.kind === ts.SyntaxKind.NullKeyword) return null;
      if (lit.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
      return undefined;
    }

    if (ts.isTypeLiteralNode(node)) {
      const obj: any = {};
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) && member.name &&
          ts.isIdentifier(member.name)
        ) {
          const propName = member.name.text;
          if (member.type) {
            obj[propName] = this.extractComplexDefaultValue(
              member.type,
              checker,
            );
          }
        }
      }
      return obj;
    }

    if (ts.isTupleTypeNode(node)) {
      return node.elements.map((element: ts.TypeNode) =>
        this.extractComplexDefaultValue(element, checker)
      );
    }

    // For union defaults like null or undefined (Default<T|null, null>)
    if (ts.isUnionTypeNode(node)) {
      const nullType = node.types.find((t) =>
        t.kind === ts.SyntaxKind.NullKeyword
      );
      const undefType = node.types.find((t) =>
        t.kind === ts.SyntaxKind.UndefinedKeyword
      );
      if (nullType) return null;
      if (undefType) return undefined;
    }

    return undefined;
  }
}
