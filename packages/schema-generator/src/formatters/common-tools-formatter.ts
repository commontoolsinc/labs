import ts, { TypeReferenceNode } from "typescript";
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
    // Handle Cell/Stream via resolved type (works for direct and aliased)
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
    
    // Handle Default via TypeNode analysis (because Default erases)
    const n = context.typeNode;
    if (n && ts.isTypeReferenceNode(n)) {
      const nodeName = ts.isIdentifier(n.typeName) ? n.typeName.text : undefined;
      if (nodeName === "Default" || this.isAliasToDefault(n, context.typeChecker)) {
        return true;
      }
    }
    
    return false;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    let nodeTypename: string | undefined;
    let resolvedTypename: string | undefined;

    // Path 1: Extract type name from TypeNode (handles direct usage)
    const n = context.typeNode;
    if (n && ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
      nodeTypename = n.typeName.text;
    }

    // Path 2: Extract type name from resolved type (handles interface aliases)
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        resolvedTypename = typeRef.target?.symbol?.name;
      }
    }

    // Handle direct TypeNode usage first (supports aliases and default extraction)
    if (n && ts.isTypeReferenceNode(n)) {
      switch (nodeTypename) {
        case "Cell":
          return this.formatCellTypeFromNode(n, context);
        case "Stream":
          return this.formatStreamTypeFromNode(n, context);
        case "Default":
          return this.formatDefaultTypeFromNode(n, context);
        default:
          // Handle Default aliases
          if (this.isAliasToDefault(n, context.typeChecker)) {
            return this.formatDefaultTypeFromNode(n, context);
          }
      }
    }

    // Fallback to resolved type for interface/class cases
    switch (resolvedTypename) {
      case "Cell":
        return this.formatCellType(type as ts.TypeReference, context);
      case "Stream":
        return this.formatStreamType(type as ts.TypeReference, context);
      case "Default":
        return this.formatDefaultType(type as ts.TypeReference, context);
    }

    throw new Error(`Unexpected CommonTools type: ${nodeTypename || resolvedTypename}`);
  }

  private formatCellType(
    typeRef: ts.TypeReference,
    context: GenerationContext,
  ): SchemaDefinition {
    // Get first type argument, let TypeScript resolve aliases
    const innerType = typeRef.typeArguments?.[0];
    if (!innerType) {
      throw new Error("Cell<T> requires type argument");
    }

    // Get the TypeNode for the inner type from the Cell's type arguments
    const innerTypeNode =
      context.typeNode && ts.isTypeReferenceNode(context.typeNode)
        ? context.typeNode.typeArguments?.[0]
        : undefined;

    const innerContext = innerTypeNode
      ? { ...context, typeNode: innerTypeNode }
      : context;
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      innerContext,
    );
    return { ...innerSchema, asCell: true };
  }

  private formatStreamType(
    typeRef: ts.TypeReference,
    context: GenerationContext,
  ): SchemaDefinition {
    const innerType = typeRef.typeArguments?.[0];
    if (!innerType) {
      throw new Error("Stream<T> requires type argument");
    }

    // Check if inner is Cell by looking at resolved type
    const isCellType = this.isCellType(innerType);

    // Get the TypeNode for the inner type from the Stream's type arguments
    const innerTypeNode =
      context.typeNode && ts.isTypeReferenceNode(context.typeNode)
        ? context.typeNode.typeArguments?.[0]
        : undefined;

    const innerContext = innerTypeNode
      ? { ...context, typeNode: innerTypeNode }
      : context;
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      innerContext,
    );

    return isCellType
      ? { ...innerSchema, asCell: true, asStream: true }
      : { ...innerSchema, asStream: true };
  }

  private formatDefaultTypeFromNode(
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

    // Get the actual types from the type nodes
    const valueType = context.typeChecker.getTypeFromTypeNode(valueTypeNode);
    const defaultType = context.typeChecker.getTypeFromTypeNode(
      defaultTypeNode,
    );

    // Generate schema for the value type
    const valueSchema = this.generateValueSchemaFromNode(
      valueType,
      valueTypeNode,
      context,
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

  private formatDefaultType(
    typeRef: ts.TypeReference,
    context: GenerationContext,
  ): SchemaDefinition {
    const valueType = typeRef.typeArguments?.[0];
    const defaultType = typeRef.typeArguments?.[1];

    if (!valueType || !defaultType) {
      throw new Error("Default<T,V> requires exactly 2 type arguments");
    }

    // Generate schema for the value type - need to handle arrays properly
    const valueSchema = this.generateValueSchema(valueType, context);

    // Extract default value from literal type - need to handle complex values
    const defaultValue = this.extractDefaultValue(defaultType, context);
    if (defaultValue !== undefined) {
      (valueSchema as any).default = defaultValue;
    }

    return valueSchema;
  }

  private formatCellTypeFromNode(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
  ): SchemaDefinition {
    const typeArgs = typeRefNode.typeArguments;
    if (!typeArgs || typeArgs.length < 1) {
      throw new Error("Cell<T> requires type argument");
    }

    const innerTypeNode = typeArgs[0];
    if (!innerTypeNode) {
      throw new Error("Cell<T> type argument cannot be undefined");
    }

    const innerType = context.typeChecker.getTypeFromTypeNode(innerTypeNode);

    const innerContext = { ...context, typeNode: innerTypeNode };
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      innerContext,
    );
    return { ...innerSchema, asCell: true };
  }

  private formatStreamTypeFromNode(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
  ): SchemaDefinition {
    const typeArgs = typeRefNode.typeArguments;
    if (!typeArgs || typeArgs.length < 1) {
      throw new Error("Stream<T> requires type argument");
    }

    const innerTypeNode = typeArgs[0];
    if (!innerTypeNode) {
      throw new Error("Stream<T> type argument cannot be undefined");
    }

    const innerType = context.typeChecker.getTypeFromTypeNode(innerTypeNode);

    // Check if inner is Cell by looking at resolved type
    const isCellType = this.isCellType(innerType);

    const innerContext = { ...context, typeNode: innerTypeNode };
    const innerSchema = this.schemaGenerator.formatChildType(
      innerType,
      innerContext,
    );

    return isCellType
      ? { ...innerSchema, asCell: true, asStream: true }
      : { ...innerSchema, asStream: true };
  }

  private generateValueSchemaFromNode(
    valueType: ts.Type,
    valueTypeNode: ts.TypeNode,
    context: GenerationContext,
  ): SchemaDefinition {
    // Let the schema generator handle any type using the type node
    return this.schemaGenerator.formatChildType(
      valueType,
      context,
      valueTypeNode,
    );
  }

  private generateValueSchema(
    valueType: ts.Type,
    context: GenerationContext,
  ): SchemaDefinition {
    // Let the schema generator handle any type
    return this.schemaGenerator.formatChildType(valueType, context);
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

  private isCellType(type: ts.Type): boolean {
    const objectType = type as ts.ObjectType;
    return !!(objectType.objectFlags & ts.ObjectFlags.Reference) &&
      (type as ts.TypeReference).target?.symbol?.name === "Cell";
  }
}
