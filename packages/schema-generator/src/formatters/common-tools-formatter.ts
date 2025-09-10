import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, Default<T,V>)
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
    // Prefer Default via node (erased at type-level)
    const n = context.typeNode;
    if (n && ts.isTypeReferenceNode(n)) {
      const nodeName = this.getTypeRefIdentifierName(n);
      if (
        nodeName === "Default" || this.isAliasToDefault(n, context.typeChecker)
      ) {
        return true;
      }
    }

    // Then handle Cell/Stream via resolved type (works for direct and aliased)
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        const resolvedName = typeRef.target?.symbol?.name;
        if (resolvedName === "Cell" || resolvedName === "Stream") {
          return true;
        }
      }
    }

    return false;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const n = context.typeNode;

    // Handle Default via node (direct or alias)
    if (n && ts.isTypeReferenceNode(n)) {
      const isDefaultNode =
        (ts.isIdentifier(n.typeName) && n.typeName.text === "Default") ||
        this.isAliasToDefault(n, context.typeChecker);
      if (isDefaultNode) {
        return this.formatDefaultType(n, context);
      }
    }

    // Determine wrapper kind using resolved type for Cell/Stream
    let resolvedTypename: string | undefined;
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        resolvedTypename = typeRef.target?.symbol?.name;
      }
    }

    // Handle Cell/Stream using unified wrapper path
    if (resolvedTypename === "Cell" || resolvedTypename === "Stream") {
      return this.formatCellOrStream(
        type as ts.TypeReference,
        n,
        context,
        resolvedTypename === "Stream",
      );
    }

    const nodeName = this.getTypeRefIdentifierName(n);
    throw new Error(
      `Unexpected CommonTools type: ${nodeName || resolvedTypename}`,
    );
  }

  private formatCellOrStream(
    typeRef: ts.TypeReference,
    typeRefNode: ts.TypeNode | undefined,
    context: GenerationContext,
    asStream: boolean,
  ): SchemaDefinition {
    const innerTypeFromType = typeRef.typeArguments?.[0];
    const innerTypeNode = typeRefNode && ts.isTypeReferenceNode(typeRefNode)
      ? typeRefNode.typeArguments?.[0]
      : undefined;

    // Resolve inner type, preferring type information; fall back to node if needed
    let innerType: ts.Type | undefined = innerTypeFromType;
    if (!innerType && innerTypeNode) {
      innerType = context.typeChecker.getTypeFromTypeNode(innerTypeNode);
    }
    if (!innerType) {
      throw new Error(
        `${asStream ? "Stream" : "Cell"}<T> requires type argument`,
      );
    }

    // Prepare inner context (preserve node when available)
    const innerContext = innerTypeNode
      ? { ...context, typeNode: innerTypeNode }
      : context;
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      innerContext,
      innerTypeNode,
    );

    // Stream<T>: do not reflect inner Cell-ness; only mark asStream
    if (asStream) {
      // Do not reflect inner Cell markers at stream level
      const { asCell: _drop, ...rest } = innerSchema as Record<string, unknown>;
      return { ...(rest as any), asStream: true } as SchemaDefinition;
    }

    // Cell<T>: disallow Cell<Stream<T>> to avoid ambiguous semantics
    if (this.isStreamType(innerType)) {
      throw new Error(
        "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>.",
      );
    }

    // Handle case where innerSchema might be boolean (per JSON Schema spec)
    if (typeof innerSchema === "boolean") {
      return innerSchema === false
        ? { asCell: true, not: true } // false = "no value is valid"
        : { asCell: true }; // true = "any value is valid"
    }
    return { ...innerSchema, asCell: true };
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

  private isAliasToDefault(
    typeNode: ts.TypeReferenceNode,
    typeChecker: ts.TypeChecker,
  ): boolean {
    return this.followAliasChain(typeNode, typeChecker, new Set());
  }

  private followAliasChain(
    typeNode: ts.TypeReferenceNode,
    typeChecker: ts.TypeChecker,
    visited: Set<string>,
  ): boolean {
    if (!ts.isIdentifier(typeNode.typeName)) {
      return false;
    }

    const typeName = typeNode.typeName.text;

    // Detect circular aliases and throw descriptive error
    if (visited.has(typeName)) {
      const aliasChain = Array.from(visited).join(" -> ");
      throw new Error(
        `Circular type alias detected: ${aliasChain} -> ${typeName}`,
      );
    }
    visited.add(typeName);

    // Check if we've reached "Default"
    if (typeName === "Default") {
      return true;
    }

    // Look up the symbol for this type name
    const symbol = typeChecker.getSymbolAtLocation(typeNode.typeName);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.TypeAlias)) {
      return false;
    }

    const aliasDeclaration = symbol.valueDeclaration ||
      symbol.declarations?.[0];
    if (!aliasDeclaration || !ts.isTypeAliasDeclaration(aliasDeclaration)) {
      return false;
    }

    const aliasedType = aliasDeclaration.type;
    if (
      ts.isTypeReferenceNode(aliasedType) &&
      ts.isIdentifier(aliasedType.typeName)
    ) {
      // Recursively follow the alias chain
      return this.followAliasChain(aliasedType, typeChecker, visited);
    }

    return false;
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
    symbol: ts.Symbol,
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
