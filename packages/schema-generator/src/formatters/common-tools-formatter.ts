import ts from "typescript";
import {
  type CellWrapperKind,
  getCellBrand,
  getCellWrapperInfo,
  isCellBrand,
} from "../typescript/cell-brand.ts";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { detectWrapperViaNode, resolveWrapperNode } from "../type-utils.ts";

type WrapperKind = CellWrapperKind;

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
    // Check via typeNode for Default (erased at type-level)
    const wrapperViaNode = detectWrapperViaNode(
      context.typeNode,
      context.typeChecker,
    );
    if (wrapperViaNode === "Default") {
      return true;
    }

    // Check if this is an Opaque<T> union (T | OpaqueRef<T>)
    if (this.isOpaqueUnion(type, context.typeChecker)) {
      return true;
    }

    if ((type.flags & ts.TypeFlags.Union) !== 0) {
      return false;
    }

    // Check if this is a wrapper type (Cell/Stream/OpaqueRef) via type structure
    const wrapperInfo = getCellWrapperInfo(type, context.typeChecker);
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

    const wrapperInfo = getCellWrapperInfo(type, context.typeChecker);
    if (wrapperInfo && !(type.flags & ts.TypeFlags.Union)) {
      const nodeToPass = this.selectWrapperTypeNode(
        n,
        resolvedWrapper,
        wrapperInfo.kind,
      );
      return this.formatWrapperType(
        wrapperInfo.typeRef,
        nodeToPass,
        context,
        wrapperInfo.kind,
      );
    }

    // If we detected a wrapper syntactically but the current type is wrapped in
    // additional layers (e.g., Opaque<OpaqueRef<...>>), recursively unwrap using
    // brand information until we reach the underlying wrapper.
    const wrapperKinds: WrapperKind[] = ["OpaqueRef", "Cell", "Stream"];
    for (const kind of wrapperKinds) {
      const unwrappedType = this.recursivelyUnwrapOpaqueRef(
        type,
        kind,
        context.typeChecker,
      );
      if (unwrappedType) {
        const nodeToPass = this.selectWrapperTypeNode(
          n,
          resolvedWrapper,
          unwrappedType.kind,
        );
        return this.formatWrapperType(
          unwrappedType.typeRef,
          nodeToPass,
          context,
          unwrappedType.kind,
        );
      }
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
    if (
      wrapperKind === "Cell" &&
      this.isStreamType(innerType, context.typeChecker)
    ) {
      throw new Error(
        "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>.",
      );
    }

    // Determine the property name to add based on wrapper kind
    // TODO(gideon): Consider updating as[Cell,Opaque,Stream] properties to use an array of brands
    // instead of boolean values, to support multiple brands like ["cell", "comparable"]
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
    if ((type.flags & ts.TypeFlags.Union) === 0) {
      const wrapperInfo = getCellWrapperInfo(type, checker);
      if (wrapperInfo && wrapperInfo.kind === targetWrapperKind) {
        return { type, typeRef: wrapperInfo.typeRef, kind: wrapperInfo.kind };
      }
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

  private isOpaqueRefType(type: ts.Type, checker: ts.TypeChecker): boolean {
    return isCellBrand(type, checker, "opaque");
  }

  /**
   * Extract the type argument T from OpaqueRef<T> or OpaqueCell<T>
   */
  private extractOpaqueRefTypeArgument(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): ts.Type | undefined {
    const wrapperInfo = getCellWrapperInfo(type, checker);
    if (!wrapperInfo || wrapperInfo.kind !== "OpaqueRef") {
      return undefined;
    }

    const typeArgs = wrapperInfo.typeRef.typeArguments ??
      checker.getTypeArguments(wrapperInfo.typeRef);
    return typeArgs && typeArgs.length > 0 ? typeArgs[0] : undefined;
  }

  private selectWrapperTypeNode(
    originalNode: ts.TypeNode | undefined,
    resolvedWrapper:
      | {
        kind: "Default" | WrapperKind;
        node: ts.TypeReferenceNode;
      }
      | undefined,
    targetKind: WrapperKind,
  ): ts.TypeReferenceNode | undefined {
    if (
      originalNode &&
      ts.isTypeReferenceNode(originalNode) &&
      originalNode.typeArguments
    ) {
      return originalNode;
    }
    if (resolvedWrapper?.kind === targetKind) {
      return resolvedWrapper.node;
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

  private isStreamType(type: ts.Type, checker: ts.TypeChecker): boolean {
    return getCellBrand(type, checker) === "stream";
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
    // Handle typeof expressions (TypeQuery nodes)
    // These reference a variable's value, like: typeof defaultRoutes
    if (ts.isTypeQueryNode(typeNode)) {
      return this.extractValueFromTypeQuery(typeNode, context);
    }

    // Handle type references that represent empty objects
    // This includes Record<string, never>, Record<K, never>, and similar mapped types
    if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments) {
      // For mapped types like Record<K, V>, if V is never, the result is an empty object
      // Check the last type argument (the value type in mapped types)
      const lastTypeArg =
        typeNode.typeArguments[typeNode.typeArguments.length - 1];
      if (lastTypeArg) {
        const lastType = context.typeChecker.getTypeFromTypeNode(lastTypeArg);
        // If the value type is never, this represents an empty object
        if (lastType.flags & ts.TypeFlags.Never) {
          return {};
        }
      }
    }

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

  private extractValueFromTypeQuery(
    typeQueryNode: ts.TypeQueryNode,
    context: GenerationContext,
  ): unknown {
    // Get the entity name being queried (e.g., "defaultRoutes" in "typeof defaultRoutes")
    const exprName = typeQueryNode.exprName;

    // Get the symbol for the referenced entity
    const symbol = context.typeChecker.getSymbolAtLocation(exprName);
    if (!symbol) {
      return undefined;
    }

    return this.extractValueFromSymbol(symbol, context);
  }

  /**
   * Extract a runtime value from a symbol's value declaration.
   * Works for variables with initializers like: const foo = [1, 2, 3]
   */
  private extractValueFromSymbol(
    symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    const valueDeclaration = symbol.valueDeclaration;
    if (!valueDeclaration) {
      return undefined;
    }

    // Check if it's a variable declaration with an initializer
    if (
      ts.isVariableDeclaration(valueDeclaration) &&
      valueDeclaration.initializer
    ) {
      return this.extractValueFromExpression(
        valueDeclaration.initializer,
        context,
      );
    }

    return undefined;
  }

  private extractValueFromExpression(
    expr: ts.Expression,
    context: GenerationContext,
  ): unknown {
    // Handle array literals like [1, 2, 3] or [{ id: "a" }, { id: "b" }]
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.map(element => this.extractValueFromExpression(element, context));
    }

    // Handle object literals like { id: "a", name: "test" }
    if (ts.isObjectLiteralExpression(expr)) {
      const obj: Record<string, unknown> = {};
      for (const property of expr.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
          const propName = property.name.text;
          obj[propName] = this.extractValueFromExpression(property.initializer, context);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          // Handle shorthand like { id } where id is a variable
          const propName = property.name.text;
          obj[propName] = this.extractValueFromExpression(property.name, context);
        }
      }
      return obj;
    }

    // Handle string literals
    if (ts.isStringLiteral(expr)) {
      return expr.text;
    }

    // Handle numeric literals
    if (ts.isNumericLiteral(expr)) {
      return Number(expr.text);
    }

    // Handle boolean literals
    if (expr.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (expr.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }

    // Handle null
    if (expr.kind === ts.SyntaxKind.NullKeyword) {
      return null;
    }

    // For more complex expressions, return undefined
    return undefined;
  }

  private extractComplexDefaultFromTypeSymbol(
    type: ts.Type,
    symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    // Try to extract from the symbol's value declaration initializer (AST-based)
    const extracted = this.extractValueFromSymbol(symbol, context);
    if (extracted !== undefined) {
      return extracted;
    }

    // Check if this is an empty object type (no properties, object type)
    // This handles cases like Record<string, never>
    if (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      context.typeChecker.getPropertiesOfType(type).length === 0
    ) {
      return {};
    }

    return undefined;
  }

}
