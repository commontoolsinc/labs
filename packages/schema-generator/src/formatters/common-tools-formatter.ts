import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { detectWrapperViaNode, resolveWrapperNode } from "../type-utils.ts";

type WrapperKind = "Cell" | "Stream" | "OpaqueRef";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, OpaqueRef<T>, Default<T,V>)
 *
 * TypeScript handles alias resolution automatically and we don't need to
 * manually traverse alias chains.
 */
export class CommonToolsFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {
    if (!schemaGenerator) {
      throw new Error(
        "CommonToolsFormatter requires a SchemaGenerator instance",
      );
    }
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Check via typeNode for Default (erased at type-level) and all wrapper aliases
    const wrapperViaNode = detectWrapperViaNode(
      context.typeNode,
      context.typeChecker,
    );
    if (wrapperViaNode) {
      return true;
    }

    // Check if this is an Opaque<T> union (T | OpaqueRef<T>)
    if (this.isOpaqueUnion(type, context.typeChecker)) {
      return true;
    }

    // Check if this is a wrapper type (Cell/Stream/OpaqueRef) via type structure
    const wrapperInfo = this.getWrapperTypeInfo(type);
    return wrapperInfo !== undefined;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const n = context.typeNode;

    // Check if this is an Opaque<T> union and handle it first
    // This prevents the UnionFormatter from creating an anyOf
    const opaqueUnionInfo = this.getOpaqueUnionInfo(type, context.typeChecker);
    if (opaqueUnionInfo) {
      // Format the base type T and add asOpaque: true
      const innerSchema = this.schemaGenerator.formatChildType(
        opaqueUnionInfo.baseType,
        context,
        undefined, // Don't pass typeNode since we're working with the unwrapped type
      );

      // Handle boolean schemas
      if (typeof innerSchema === "boolean") {
        return innerSchema === false
          ? { asOpaque: true, not: true } as SchemaDefinition // false = "no value is valid"
          : { asOpaque: true } as SchemaDefinition; // true = "any value is valid"
      }
      return { ...innerSchema, asOpaque: true } as SchemaDefinition;
    }

    // Check via typeNode for all wrapper types (handles both direct usage and aliases)
    const resolvedWrapper = n
      ? resolveWrapperNode(n, context.typeChecker)
      : undefined;

    // Handle Default via node (direct or alias)
    if (resolvedWrapper?.kind === "Default") {
      // For Default, we need the node with concrete type arguments.
      // If the original node has type arguments, use it.
      // Otherwise, use the resolved node (for direct Default references).
      const nodeForDefault = n && ts.isTypeReferenceNode(n) && n.typeArguments
        ? n // Original has type args, use it for concrete types
        : resolvedWrapper.node; // Direct reference or fallback

      if (nodeForDefault && ts.isTypeReferenceNode(nodeForDefault)) {
        return this.formatDefaultType(nodeForDefault, context);
      }
    }

    // Handle Cell/Stream/OpaqueRef via node (direct or alias)
    if (resolvedWrapper && resolvedWrapper.kind !== "Default") {
      // Use the ACTUAL type from the usage site (which has concrete type arguments)
      const wrapperInfo = this.getWrapperTypeInfo(type);
      if (wrapperInfo) {
        // For choosing which node to pass to formatWrapperType:
        // - If original node has type arguments: use it (has concrete types from usage site)
        // - If original node is just identifier (alias): use resolved node
        //   formatWrapperType will check if node has type args before extracting inner types
        const nodeToPass = n && ts.isTypeReferenceNode(n) && n.typeArguments
          ? n // Original has type args, use it
          : resolvedWrapper.node; // Original is just alias, use resolved (but won't extract inner types from it)

        return this.formatWrapperType(
          wrapperInfo.typeRef,
          nodeToPass,
          context,
          wrapperInfo.kind,
        );
      } else {
        // If we detected a wrapper via typeNode but the type structure is complex
        // (e.g., wrapped in Opaque union), recursively unwrap to find the base wrapper type
        const unwrappedType = this.recursivelyUnwrapOpaqueRef(
          type,
          resolvedWrapper.kind,
          context.typeChecker,
        );
        if (unwrappedType) {
          const nodeToPass = n && ts.isTypeReferenceNode(n) && n.typeArguments
            ? n
            : resolvedWrapper.node;

          return this.formatWrapperType(
            unwrappedType.typeRef,
            nodeToPass,
            context,
            unwrappedType.kind,
          );
        }
        // If we couldn't unwrap, fall through to regular handling
      }
    }

    // Fallback: try to get wrapper type information from type structure
    // (for cases where we don't have a typeNode)
    const wrapperInfo = this.getWrapperTypeInfo(type);
    if (wrapperInfo) {
      return this.formatWrapperType(
        wrapperInfo.typeRef,
        n,
        context,
        wrapperInfo.kind,
      );
    }

    const nodeName = this.getTypeRefIdentifierName(n);
    throw new Error(
      `Unexpected CommonTools type: ${nodeName}`,
    );
  }

  private formatWrapperType(
    typeRef: ts.TypeReference,
    typeRefNode: ts.TypeNode | undefined,
    context: GenerationContext,
    wrapperKind: WrapperKind,
  ): SchemaDefinition {
    const innerTypeFromType = typeRef.typeArguments?.[0];

    // Only extract innerTypeNode if the typeRefNode has type arguments AND
    // those arguments are not generic type parameters.
    // If typeRefNode has no type arguments, or if the arguments are generic parameters
    // (e.g., T from an alias declaration), we should NOT extract inner types from it.
    let innerTypeNode: ts.TypeNode | undefined = undefined;
    if (
      typeRefNode && ts.isTypeReferenceNode(typeRefNode) &&
      typeRefNode.typeArguments
    ) {
      const firstArg = typeRefNode.typeArguments[0];
      if (firstArg) {
        // Check if this node represents a type parameter
        const argType = context.typeChecker.getTypeFromTypeNode(firstArg);
        const isTypeParameter =
          (argType.flags & ts.TypeFlags.TypeParameter) !== 0;
        if (!isTypeParameter) {
          // Not a type parameter, safe to use
          innerTypeNode = firstArg;
        }
        // Otherwise leave innerTypeNode as undefined (don't use type parameter nodes)
      }
    }

    // Resolve inner type, preferring type information; fall back to node if needed
    let innerType: ts.Type | undefined = innerTypeFromType;
    if (!innerType && innerTypeNode) {
      innerType = context.typeChecker.getTypeFromTypeNode(innerTypeNode);
    }
    if (!innerType) {
      throw new Error(
        `${wrapperKind}<T> requires type argument`,
      );
    }

    // When we resolve aliases (e.g., StringCell -> Cell<string>), the resolved node's
    // type arguments may contain unbound generics (e.g., T) from the alias declaration.
    // In that case, we must NOT pass the node, since the type information has the
    // concrete types (e.g., string) from the usage site.
    // We detect this by checking if the inner type is a type parameter.
    const innerTypeIsGeneric =
      (innerType.flags & ts.TypeFlags.TypeParameter) !== 0;

    // Don't pass synthetic TypeNodes - they lose type information (especially for arrays)
    // Synthetic nodes have pos === -1 and end === -1
    // But DO pass real TypeNodes from source code for proper type detection (e.g., Default)
    const isSyntheticNode = innerTypeNode && innerTypeNode.pos === -1 &&
      innerTypeNode.end === -1;

    // Only pass typeNode if it's real (not synthetic) AND not a generic type parameter
    const shouldPassTypeNode = innerTypeNode && !isSyntheticNode &&
      !innerTypeIsGeneric;
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      context,
      shouldPassTypeNode ? innerTypeNode : undefined,
    );

    // Stream<T>: do not reflect inner Cell-ness; only mark asStream
    if (wrapperKind === "Stream") {
      const { asCell: _drop, ...rest } = innerSchema as Record<string, unknown>;
      return { ...(rest as any), asStream: true } as SchemaDefinition;
    }

    // Cell<T>: disallow Cell<Stream<T>> to avoid ambiguous semantics
    if (wrapperKind === "Cell" && this.isStreamType(innerType)) {
      throw new Error(
        "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>.",
      );
    }

    // Determine the property name to add based on wrapper kind
    const propertyName = wrapperKind === "Cell" ? "asCell" : "asOpaque";

    // Handle case where innerSchema might be boolean (per JSON Schema spec)
    if (typeof innerSchema === "boolean") {
      return innerSchema === false
        ? { [propertyName]: true, not: true } // false = "no value is valid"
        : { [propertyName]: true }; // true = "any value is valid"
    }
    return { ...innerSchema, [propertyName]: true };
  }

  /**
   * Recursively unwrap OpaqueRef layers to find a wrapper type (Cell/Stream/OpaqueRef).
   * This handles cases like Opaque<OpaqueRef<Stream<T>>> where the type is wrapped in
   * multiple layers of OpaqueRef due to the Opaque type's recursive definition.
   */
  private recursivelyUnwrapOpaqueRef(
    type: ts.Type,
    targetWrapperKind: WrapperKind,
    checker: ts.TypeChecker,
    depth: number = 0,
  ):
    | { type: ts.Type; typeRef: ts.TypeReference; kind: WrapperKind }
    | undefined {
    // Prevent infinite recursion
    if (depth > 10) {
      return undefined;
    }

    // Check if this type itself is the target wrapper
    const wrapperInfo = this.getWrapperTypeInfo(type);
    if (wrapperInfo && wrapperInfo.kind === targetWrapperKind) {
      return { type, typeRef: wrapperInfo.typeRef, kind: wrapperInfo.kind };
    }

    // If this is a union (e.g., from Opaque<T>), check each member
    if (type.flags & ts.TypeFlags.Union) {
      const unionType = type as ts.UnionType;
      for (const member of unionType.types) {
        // Try to unwrap this member
        const result = this.recursivelyUnwrapOpaqueRef(
          member,
          targetWrapperKind,
          checker,
          depth + 1,
        );
        if (result) return result;
      }
    }

    // If this is an OpaqueRef type, extract its type argument and recurse
    if (this.isOpaqueRefType(type, checker)) {
      const innerType = this.extractOpaqueRefTypeArgument(type, checker);
      if (innerType) {
        return this.recursivelyUnwrapOpaqueRef(
          innerType,
          targetWrapperKind,
          checker,
          depth + 1,
        );
      }
    }

    return undefined;
  }

  /**
   * Check if a type is an Opaque<T> union (T | OpaqueRef<T>)
   */
  private isOpaqueUnion(type: ts.Type, checker: ts.TypeChecker): boolean {
    return this.getOpaqueUnionInfo(type, checker) !== undefined;
  }

  /**
   * Extract information from an Opaque<T> union type.
   * Opaque<T> is defined as: T | OpaqueRef<T>
   * This function detects this pattern and returns the base type T.
   */
  private getOpaqueUnionInfo(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): { baseType: ts.Type } | undefined {
    // Must be a union type
    if (!(type.flags & ts.TypeFlags.Union)) {
      return undefined;
    }

    const unionType = type as ts.UnionType;
    const members = unionType.types;

    // Must have exactly 2 members
    if (members.length !== 2) {
      return undefined;
    }

    // One member should be OpaqueRef<T>, the other should be T
    let opaqueRefMember: ts.Type | undefined;
    let baseMember: ts.Type | undefined;

    for (const member of members) {
      // Check if this member is an OpaqueRef type (it will be an intersection)
      const isOpaqueRef = this.isOpaqueRefType(member, checker);
      if (isOpaqueRef) {
        opaqueRefMember = member;
      } else {
        baseMember = member;
      }
    }

    // Both members must be present for this to be an Opaque<T> union
    if (!opaqueRefMember || !baseMember) {
      return undefined;
    }

    // Verify that the OpaqueRef's type argument matches the base type
    // Extract T from OpaqueRef<T>
    const opaqueRefInnerType = this.extractOpaqueRefTypeArgument(
      opaqueRefMember,
      checker,
    );
    if (!opaqueRefInnerType) {
      return undefined;
    }

    // The inner type of OpaqueRef should match the base member
    // Use type equality check
    const innerTypeString = checker.typeToString(opaqueRefInnerType);
    const baseTypeString = checker.typeToString(baseMember);

    if (innerTypeString !== baseTypeString) {
      // Not a matching Opaque<T> pattern
      return undefined;
    }

    return { baseType: baseMember };
  }

  /**
   * Check if a type has a CELL_BRAND property (is a cell type)
   */
  private isCellType(type: ts.Type): boolean {
    return type.getProperty("CELL_BRAND") !== undefined;
  }

  /**
   * Get the CELL_BRAND string value from a type, if it has one.
   * Returns the brand string ("opaque", "cell", "stream", etc.) or undefined.
   */
  private getCellBrand(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): string | undefined {
    const brandSymbol = type.getProperty("CELL_BRAND");
    if (brandSymbol && brandSymbol.valueDeclaration) {
      const brandType = checker.getTypeOfSymbolAtLocation(
        brandSymbol,
        brandSymbol.valueDeclaration,
      );
      if (brandType.flags & ts.TypeFlags.StringLiteral) {
        return (brandType as ts.StringLiteralType).value;
      }
    }
    return undefined;
  }

  /**
   * Check if a type is an OpaqueRef type by checking the CELL_BRAND property.
   * All cell types (OpaqueCell, Cell, Stream) are intersections with CELL_BRAND,
   * but only OpaqueCell has brand "opaque".
   */
  private isOpaqueRefType(type: ts.Type, checker: ts.TypeChecker): boolean {
    // Try CELL_BRAND first - most reliable method
    const brand = this.getCellBrand(type, checker);
    if (brand === "opaque") {
      return true;
    }

    // Fallback: check by constituent interface names for backward compatibility
    if (type.flags & ts.TypeFlags.Intersection) {
      const intersectionType = type as ts.IntersectionType;
      for (const constituent of intersectionType.types) {
        if (constituent.flags & ts.TypeFlags.Object) {
          const objectType = constituent as ts.ObjectType;
          if (objectType.objectFlags & ts.ObjectFlags.Reference) {
            const typeRef = objectType as ts.TypeReference;
            const name = typeRef.target?.symbol?.name;
            // Check for OpaqueRef-specific interface names (old and new)
            if (
              name === "OpaqueRefMethods" || name === "OpaqueCell" ||
              name === "IOpaqueCell"
            ) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * Extract the type argument T from OpaqueRef<T> or OpaqueCell<T>
   */
  private extractOpaqueRefTypeArgument(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): ts.Type | undefined {
    if (!(type.flags & ts.TypeFlags.Intersection)) {
      return undefined;
    }

    const intersectionType = type as ts.IntersectionType;
    for (const constituent of intersectionType.types) {
      if (constituent.flags & ts.TypeFlags.Object) {
        const objectType = constituent as ts.ObjectType;
        if (objectType.objectFlags & ts.ObjectFlags.Reference) {
          const typeRef = objectType as ts.TypeReference;
          const name = typeRef.target?.symbol?.name;
          // Check for both old (OpaqueRefMethods) and new (OpaqueCell, IOpaqueCell, BrandedCell) names
          if (
            name === "OpaqueRefMethods" || name === "OpaqueCell" ||
            name === "IOpaqueCell" || name === "BrandedCell"
          ) {
            // Found wrapper type with type argument, extract T
            const typeArgs = checker.getTypeArguments(typeRef);
            if (typeArgs && typeArgs.length > 0) {
              return typeArgs[0];
            }
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Get wrapper type information (Cell/Stream/OpaqueRef)
   * Handles both direct references and intersection types (e.g., OpaqueRef<"literal">)
   * Returns the wrapper kind and the TypeReference needed for formatting
   */
  private getWrapperTypeInfo(
    type: ts.Type,
  ): { kind: WrapperKind; typeRef: ts.TypeReference } | undefined {
    // Check direct object type reference
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        const name = typeRef.target?.symbol?.name;
        if (
          name === "Cell" || name === "Stream" || name === "OpaqueRef" ||
          name === "OpaqueCell"
        ) {
          // OpaqueCell should be treated as OpaqueRef
          const kind = name === "OpaqueCell" ? "OpaqueRef" : name;
          return { kind, typeRef };
        }
      }
    }

    // OpaqueRef/OpaqueCell with literal type arguments becomes an intersection
    // e.g., OpaqueRef<"initial"> expands to: OpaqueCell<"initial"> & IOpaqueCell<"initial">
    // We need to detect these internal types to handle this case
    if (type.flags & ts.TypeFlags.Intersection) {
      const intersectionType = type as ts.IntersectionType;
      for (const constituent of intersectionType.types) {
        if (constituent.flags & ts.TypeFlags.Object) {
          const objectType = constituent as ts.ObjectType;
          if (objectType.objectFlags & ts.ObjectFlags.Reference) {
            const typeRef = objectType as ts.TypeReference;
            const name = typeRef.target?.symbol?.name;
            // Check for both old (OpaqueRefMethods) and new (OpaqueCell, IOpaqueCell) internal types
            if (
              name === "OpaqueRefMethods" || name === "OpaqueCell" ||
              name === "IOpaqueCell"
            ) {
              return { kind: "OpaqueRef", typeRef };
            }
          }
        }
      }
    }

    return undefined;
  }

  private getTypeRefIdentifierName(
    node?: ts.TypeNode,
  ): string | undefined {
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const tn = node.typeName;
    return ts.isIdentifier(tn) ? tn.text : undefined;
  }

  private isStreamType(type: ts.Type): boolean {
    const objectType = type as ts.ObjectType;
    return !!(objectType.objectFlags & ts.ObjectFlags.Reference) &&
      (type as ts.TypeReference).target?.symbol?.name === "Stream";
  }

  private formatDefaultType(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
  ): SchemaDefinition {
    const typeArgs = typeRefNode.typeArguments;
    if (!typeArgs || typeArgs.length < 2) {
      throw new Error("Default<T,V> requires exactly 2 type arguments");
    }

    const valueTypeNode = typeArgs[0];
    const defaultTypeNode = typeArgs[1];

    if (!valueTypeNode || !defaultTypeNode) {
      throw new Error("Default<T,V> type arguments cannot be undefined");
    }

    // Get the value type from the type nodes
    const valueType = context.typeChecker.getTypeFromTypeNode(valueTypeNode);

    // Generate schema for the value type
    const valueSchema = this.schemaGenerator.formatChildType(
      valueType,
      context,
      valueTypeNode,
    );

    // Extract default value from the default type node (this can handle complex literals)
    const defaultValue = this.extractDefaultValueFromNode(
      defaultTypeNode,
      context,
    );

    if (defaultValue !== undefined) {
      // JSON Schema Draft 2020-12 allows default as a sibling of $ref
      // Simply add the default property directly to the schema
      if (typeof valueSchema === "boolean") {
        // Boolean schemas (true/false) cannot have properties directly
        // For true: { default: value } (any value is valid)
        // For false: { not: true, default: value } (no value is valid)
        return valueSchema === false
          ? { not: true, default: defaultValue } as SchemaDefinition
          : { default: defaultValue } as SchemaDefinition;
      }
      (valueSchema as any).default = defaultValue;
    }

    return valueSchema;
  }

  private extractDefaultValueFromNode(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): unknown {
    // Handle literal types
    if (ts.isLiteralTypeNode(typeNode)) {
      const literal = typeNode.literal;
      if (ts.isStringLiteral(literal)) return literal.text;
      if (ts.isNumericLiteral(literal)) return Number(literal.text);
      if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (literal.kind === ts.SyntaxKind.NullKeyword) return null;
    }

    // Handle array literals (tuples) like [1, 2] or ["item1", "item2"]
    if (ts.isTupleTypeNode(typeNode)) {
      return typeNode.elements.map((element) =>
        this.extractDefaultValueFromNode(element, context)
      );
    }

    // Handle object literals like { theme: "dark", count: 10 }
    if (ts.isTypeLiteralNode(typeNode)) {
      const obj: Record<string, unknown> = {};
      for (const member of typeNode.members) {
        if (
          ts.isPropertySignature(member) && member.name &&
          ts.isIdentifier(member.name) && member.type
        ) {
          const propName = member.name.text;
          obj[propName] = this.extractDefaultValueFromNode(
            member.type,
            context,
          );
        }
      }
      return obj;
    }

    // Handle keywords
    if (typeNode.kind === ts.SyntaxKind.NullKeyword) return null;
    if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

    // Fallback: try to get the type and extract from it
    const type = context.typeChecker.getTypeFromTypeNode(typeNode);
    return this.extractDefaultValue(type, context);
  }

  private extractDefaultValue(
    type: ts.Type,
    context: GenerationContext,
  ): unknown {
    // First try simple literal extraction
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as any).intrinsicName === "true";
    }
    if (type.flags & ts.TypeFlags.Null) {
      return null;
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return undefined;
    }

    // For complex values (arrays/objects), try to extract from the type's symbol
    // This is a simplified approach that works for many cases
    const symbol = type.getSymbol();
    if (symbol && symbol.valueDeclaration) {
      return this.extractComplexDefaultFromTypeSymbol(type, symbol, context);
    }

    return undefined;
  }

  private extractComplexDefaultFromTypeSymbol(
    type: ts.Type,
    _symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    // For now, try to extract from type string - this is a fallback approach
    const typeString = context.typeChecker.typeToString(type);

    // Handle array literals like ["item1", "item2"]
    if (typeString.startsWith("[") && typeString.endsWith("]")) {
      try {
        return JSON.parse(typeString);
      } catch {
        // If JSON parsing fails, try simpler extraction
        return this.parseArrayLiteral(typeString);
      }
    }

    // Handle object literals like { theme: "dark", count: 10 }
    if (typeString.startsWith("{") && typeString.endsWith("}")) {
      try {
        // Convert TS object syntax to JSON syntax
        const jsonString = typeString
          .replace(/(\w+):/g, '"$1":') // Quote property names
          .replace(/'/g, '"'); // Convert single quotes to double quotes
        return JSON.parse(jsonString);
      } catch {
        // If JSON parsing fails, return a simpler fallback
        return this.parseObjectLiteral(typeString);
      }
    }

    return undefined;
  }

  private parseArrayLiteral(str: string): unknown[] {
    // Simple array parsing for basic cases
    if (str === "[]") return [];

    // Remove brackets and split by comma
    const inner = str.slice(1, -1);
    if (!inner.trim()) return [];

    const items = inner.split(",").map((item) => {
      const trimmed = item.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1); // String literal
      }
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1); // String literal
      }
      if (!isNaN(Number(trimmed))) {
        return Number(trimmed); // Number literal
      }
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
      if (trimmed === "null") return null;
      return trimmed; // Fallback
    });

    return items;
  }

  private parseObjectLiteral(str: string): Record<string, unknown> {
    // Very basic object parsing - this is a fallback
    const obj: Record<string, unknown> = {};

    // Remove braces
    const inner = str.slice(1, -1).trim();
    if (!inner) return obj;

    // This is a simplified parser - for more complex cases we'd need proper AST parsing
    const pairs = inner.split(",");
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split(":");
      if (key && valueParts.length > 0) {
        const keyTrimmed = key.trim().replace(/"/g, "");
        const valueStr = valueParts.join(":").trim();

        // Parse simple values
        if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
          obj[keyTrimmed] = valueStr.slice(1, -1);
        } else if (!isNaN(Number(valueStr))) {
          obj[keyTrimmed] = Number(valueStr);
        } else if (valueStr === "true") {
          obj[keyTrimmed] = true;
        } else if (valueStr === "false") {
          obj[keyTrimmed] = false;
        } else if (valueStr === "null") {
          obj[keyTrimmed] = null;
        } else {
          obj[keyTrimmed] = valueStr;
        }
      }
    }

    return obj;
  }
}
