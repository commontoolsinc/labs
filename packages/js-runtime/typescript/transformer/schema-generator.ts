import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: true,
  level: "info",
});

/**
 * Get a stable, human-readable type name for definitions
 */
function getStableTypeName(
  type: ts.Type,
  definitions?: Record<string, any>,
): string {
  const symbolName = type.symbol?.name;
  if (symbolName && symbolName !== "__type") return symbolName;
  if (definitions) {
    return `Type${Object.keys(definitions).length}`;
  }
  return "Type0";
}

/**
 * Helper to extract array element type using multiple detection methods
 */
function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  // Check ObjectFlags.Reference for Array/ReadonlyArray
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;

  if (objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = type as ts.TypeReference;
    const symbol = typeRef.target?.symbol;
    if (
      symbol && (symbol.name === "Array" || symbol.name === "ReadonlyArray")
    ) {
      const elementType = typeRef.typeArguments?.[0];
      return elementType;
    }
  }

  // Check symbol name for Array
  if (type.symbol?.name === "Array") {
    const typeRef = type as ts.TypeReference;
    const elementType = typeRef.typeArguments?.[0];
    return elementType;
  }

  // Use numeric index type as fallback
  try {
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (elementType) {
      return elementType;
    }
  } catch (error) {
    // Stack overflow can happen with recursive types
    // Don't log as it could cause another stack overflow
    // Emit a lightweight breadcrumb without touching the error object
    try {
      logger.warn(() =>
        "getArrayElementType: checker.getIndexTypeOfType threw; treating as non-array"
      );
    } catch (_e) {
      // Swallow any logging issues to remain safe
    }
  }

  return undefined;
}

/**
 * Safely resolve a property's type, preferring AST nodes to avoid deep checker recursion
 */
function safeGetPropertyType(
  prop: ts.Symbol,
  parentType: ts.Type,
  checker: ts.TypeChecker,
  fallbackNode?: ts.TypeNode,
): ts.Type {
  // Prefer declared type node when available
  const decl = prop.valueDeclaration;
  if (decl && ts.isPropertySignature(decl) && decl.type) {
    try {
      return checker.getTypeFromTypeNode(decl.type);
    } catch (_) {
      // fallthrough
    }
  }
  if (fallbackNode) {
    try {
      return checker.getTypeFromTypeNode(fallbackNode);
    } catch (_) {
      // fallthrough
    }
  }
  // Last resort: use symbol location
  try {
    return checker.getTypeOfSymbolAtLocation(
      prop,
      prop.valueDeclaration || fallbackNode || prop.declarations?.[0]!,
    );
  } catch (_) {
    // As a conservative fallback, return the parent type to avoid crashes
    try {
      logger.warn(() =>
        "safeGetPropertyType: checker.getTypeOfSymbolAtLocation threw; returning parentType"
      );
    } catch (_e) {
      // Swallow any logging issues to remain safe
    }
    return parentType;
  }
}

/**
 * Build an object schema for a given type. This is separated so we can reuse it
 * while guarding against self-recursion via definitionStack.
 */
function buildObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode | undefined,
  depth: number,
  seenTypes: Set<ts.Type>,
  cyclicTypes: Set<ts.Type> | undefined,
  definitions: Record<string, any> | undefined,
  definitionStack: Set<ts.Type>,
): any {
  const properties: any = {};
  const required: string[] = [];

  const props = checker.getPropertiesOfType(type);
  for (const prop of props) {
    const propName = prop.getName();
    if (propName.startsWith("__")) continue;

    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (!isOptional) required.push(propName);

    let propTypeNode: ts.TypeNode | undefined;
    const propDecl = prop.valueDeclaration;
    if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
      propTypeNode = propDecl.type;
    }

    const resolvedPropType = safeGetPropertyType(
      prop,
      type,
      checker,
      propTypeNode,
    );

    const propSchema = typeToJsonSchemaHelper(
      resolvedPropType,
      checker,
      propTypeNode,
      depth + 1,
      seenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false,
    );

    properties[propName] = propSchema;
  }

  const schema: any = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Convert a TypeScript type to JSONSchema (helper with cycle handling)
 */
function typeToJsonSchemaHelper(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
  depth: number = 0,
  seenTypes: Set<ts.Type> = new Set(),
  cyclicTypes?: Set<ts.Type>,
  definitions?: Record<string, any>,
  definitionStack: Set<ts.Type> = new Set(),
  isRootType: boolean = false,
): any {
  // If cyclicTypes is provided, check if this is a cyclic type
  if (cyclicTypes && cyclicTypes.has(type) && definitions) {
    const typeName = getStableTypeName(type, definitions);

    // If we're already generating or have seen this type in the current path, return a $ref
    if (definitionStack.has(type) || seenTypes.has(type)) {
      return { "$ref": `#/definitions/${typeName}` };
    }

    // Non-root: ensure definition exists and return a $ref
    if (!isRootType) {
      if (!definitions[typeName]) {
        // Mark as in-progress to break self-recursion
        definitionStack.add(type);
        // Add to seen types for this path
        const newSeen = new Set(seenTypes);
        newSeen.add(type);
        const defSchema = buildObjectSchema(
          type,
          checker,
          typeNode,
          depth,
          newSeen,
          cyclicTypes,
          definitions,
          definitionStack,
        );
        definitions[typeName] = defSchema;
        definitionStack.delete(type);
      }
      return { "$ref": `#/definitions/${typeName}` };
    }

    // Root cyclic type: allow building root schema with self-refs
    // Mark as in-progress so inner references become $ref
    definitionStack.add(type);
    seenTypes.add(type);
  }

  // Old cycle detection for when cyclicTypes is not provided
  if (!cyclicTypes && seenTypes.has(type)) {
    return {
      type: "object",
      additionalProperties: true,
      $comment: "Recursive type detected - placeholder schema",
    };
  }

  // Create a new set with this type added for recursive calls where appropriate
  const newSeenTypes = new Set(seenTypes);

  // Only add interface/class types to seenTypes - only these can cause recursive cycles
  // Skip arrays, built-in types, and other types that can't self-reference
  if (type.flags & ts.TypeFlags.Object) {
    const symbol = type.getSymbol();

    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !["Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet"]
        .includes(symbol.name);

    if (shouldTrack) {
      newSeenTypes.add(type);
    }
  }

  // If we have a type node, check if it's a type reference to Default<T, V>
  if (typeNode && ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    // Check if this is Default or a type that resolves to Default
    if (ts.isIdentifier(typeName)) {
      // Check if the resolved type is Default
      // Wrap in try-catch to handle potential stack overflow with recursive types
      let symbol: ts.Symbol | undefined;
      let resolvedType: ts.Type;

      try {
        symbol = checker.getSymbolAtLocation(typeName);
        resolvedType = checker.getTypeFromTypeNode(typeNode);
      } catch (error) {
        // If we get a stack overflow, skip the Default type checking
        // Don't log as it could cause another stack overflow
        // Fall through to normal type processing
        try {
          logger.warn(() =>
            "typeToJsonSchemaHelper: resolving Default type caused checker error; skipping Default handling"
          );
        } catch (_e) {
          // Swallow any logging issues to remain safe
        }
        symbol = undefined;
        resolvedType = type;
      }

      // Check if the symbol is a type alias that resolves to Default
      let declaredType: ts.Type | undefined;
      let isDefaultAlias = false;
      if (symbol && symbol.flags & ts.SymbolFlags.TypeAlias) {
        // Get the type alias declaration to check what it aliases to
        const aliasDecl = symbol.declarations?.[0];
        if (
          aliasDecl && ts.isTypeAliasDeclaration(aliasDecl) && aliasDecl.type
        ) {
          // Check if the type node is a reference to Default
          if (
            ts.isTypeReferenceNode(aliasDecl.type) &&
            ts.isIdentifier(aliasDecl.type.typeName) &&
            aliasDecl.type.typeName.text === "Default"
          ) {
            isDefaultAlias = true;
          }
        }
        declaredType = checker.getDeclaredTypeOfSymbol(symbol);
      }

      const isDefaultType = typeName.text === "Default" ||
        (resolvedType as any).target?.symbol?.name === "Default" ||
        resolvedType.symbol?.name === "Default" ||
        (resolvedType as any).aliasSymbol?.name === "Default" ||
        (declaredType &&
          (declaredType as any).aliasSymbol?.name === "Default") ||
        isDefaultAlias;

      if (isDefaultType) {
        // For type aliases that resolve to Default, we need to get the instantiated type
        // The resolvedType is the final type (e.g., string), but we need the Default<string, "hello"> type
        if (isDefaultAlias) {
          // This is a type alias to Default - we need to instantiate it with the type arguments
          const typeArgs = typeNode.typeArguments;
          if (typeArgs && typeArgs.length >= 2) {
            const innerTypeNode = typeArgs[0];
            const defaultValueNode = typeArgs[1];

            // Get the inner type
            const innerType = checker.getTypeFromTypeNode(innerTypeNode);
            const schema = typeToJsonSchemaHelper(
              innerType,
              checker,
              innerTypeNode,
              depth + 1,
              newSeenTypes,
              cyclicTypes,
              definitions,
              definitionStack,
              false, // Default inner types are never root types
            );

            // Extract the default value from the type node
            const defaultValue = extractValueFromTypeNode(
              defaultValueNode,
              checker,
            );
            if (defaultValue !== undefined) {
              schema.default = defaultValue;
            }

            return schema;
          }
        }

        // For type aliases, we need to check if the resolved type has type arguments
        const typeRef = resolvedType as ts.TypeReference;
        if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
          const innerType = typeRef.typeArguments[0];
          const defaultValueType = typeRef.typeArguments[1];

          // Get the schema for the inner type
          const schema = typeToJsonSchemaHelper(
            innerType,
            checker,
            typeNode,
            depth + 1,
            newSeenTypes,
            cyclicTypes,
            definitions,
            definitionStack,
            false, // Default inner types are never root types
          );

          // Try to extract the literal value from the default value type
          if (defaultValueType.flags & ts.TypeFlags.NumberLiteral) {
            // @ts-ignore - accessing value property
            schema.default = (defaultValueType as any).value;
          } else if (defaultValueType.flags & ts.TypeFlags.StringLiteral) {
            // @ts-ignore - accessing value property
            schema.default = (defaultValueType as any).value;
          } else if (defaultValueType.flags & ts.TypeFlags.BooleanLiteral) {
            // @ts-ignore - accessing intrinsicName property
            schema.default = (defaultValueType as any).intrinsicName === "true";
          } else if ((defaultValueType as any).intrinsicName === "true") {
            schema.default = true;
          } else if ((defaultValueType as any).intrinsicName === "false") {
            schema.default = false;
          }

          return schema;
        } else if (
          typeNode.typeArguments && typeNode.typeArguments.length >= 2
        ) {
          // Fallback for direct Default<T, V> usage
          const innerTypeNode = typeNode.typeArguments[0];
          const defaultValueNode = typeNode.typeArguments[1];

          // Get the inner type
          const innerType = checker.getTypeFromTypeNode(innerTypeNode);
          const schema = typeToJsonSchemaHelper(
            innerType,
            checker,
            innerTypeNode,
            depth + 1,
            newSeenTypes,
            cyclicTypes,
            definitions,
            definitionStack,
            false, // Default inner types are never root types
          );

          // Extract the default value from the type node
          const defaultValue = extractValueFromTypeNode(
            defaultValueNode,
            checker,
          );
          if (defaultValue !== undefined) {
            schema.default = defaultValue;
          }

          return schema;
        }
      }
    }
  }

  // Check if this is a Cell<T> or Stream<T> type at the top level
  // Check for Cell type by symbol name (handles type aliases)
  if (type.symbol?.name === "Cell") {
    // This is a Cell<T> type
    let innerType = type;

    // Extract the inner type
    if (type.symbol && type.symbol.getName() === "Cell") {
      const typeRef = type as ts.TypeReference;
      if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
        innerType = typeRef.typeArguments[0];
      }
    } else if ((type as any).resolvedTypeArguments) {
      const resolvedArgs = (type as any).resolvedTypeArguments;
      if (resolvedArgs.length > 0) {
        innerType = resolvedArgs[0];
      }
    }

    // Get schema for the inner type
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments &&
      typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = typeNode.typeArguments[0];
    }
    const schema = typeToJsonSchemaHelper(
      innerType,
      checker,
      innerTypeNode || typeNode,
      depth + 1,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false, // Cell inner types are never root types
    );
    schema.asCell = true;
    return schema;
  }

  // Check for Stream type by symbol name (handles type aliases)
  if (type.symbol?.name === "Stream") {
    // This is a Stream<T> type
    let innerType = type;

    // Extract the inner type
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
      innerType = typeRef.typeArguments[0];
    }

    // Get schema for the inner type
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments &&
      typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = typeNode.typeArguments[0];
    }
    const schema = typeToJsonSchemaHelper(
      innerType,
      checker,
      innerTypeNode || typeNode,
      depth + 1,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false, // Stream inner types are never root types
    );
    schema.asStream = true;
    return schema;
  }

  // Handle primitive types
  if (type.flags & ts.TypeFlags.String) {
    return { type: "string" };
  }
  if (type.flags & ts.TypeFlags.Number) {
    return { type: "number" };
  }
  if (type.flags & ts.TypeFlags.Boolean) {
    return { type: "boolean" };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    // Handle boolean literals (true/false) as boolean type
    return { type: "boolean" };
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { type: "null" };
  }

  // Handle arrays BEFORE object types (arrays are objects too)
  // First check if we have an array type node (most reliable)
  if (typeNode && ts.isArrayTypeNode(typeNode)) {
    const elementTypeNode = typeNode.elementType;
    // Try to get the element type from the node
    const elementType = checker.getTypeFromTypeNode(elementTypeNode);
    return {
      type: "array",
      items: typeToJsonSchemaHelper(
        elementType,
        checker,
        elementTypeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false, // array elements are never root types
      ),
    };
  }

  // Otherwise use type-based detection
  const arrayElementType = getArrayElementType(type, checker);
  if (arrayElementType) {
    // Extract element type node if we have a type node
    let elementTypeNode: ts.TypeNode | undefined;
    if (
      typeNode && ts.isTypeReferenceNode(typeNode) &&
      typeNode.typeName && typeNode.typeArguments &&
      typeNode.typeArguments.length > 0
    ) {
      elementTypeNode = typeNode.typeArguments[0];
    }

    return {
      type: "array",
      items: typeToJsonSchemaHelper(
        arrayElementType,
        checker,
        elementTypeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false, // array elements are never root types
      ),
    };
  }

  // Handle Date
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Date") {
    return { type: "string", format: "date-time" };
  }

  // Check if this is a type reference (e.g., Default<T, V>)
  if ((type as any).target) {
    const typeRef = type as ts.TypeReference;
    const target = (typeRef as any).target;

    // Check if it's Default type by checking the symbol name
    if (target.symbol && target.symbol.name === "Default") {
      // This is a generic type Default<T, V>
      if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
        const innerType = typeRef.typeArguments[0];
        const defaultValueType = typeRef.typeArguments[1];

        // Get the schema for the inner type
        const schema = typeToJsonSchemaHelper(
          innerType,
          checker,
          typeNode,
          depth + 1,
          newSeenTypes,
          cyclicTypes,
          definitions,
          definitionStack,
          false, // Default inner types are never root types
        );

        // Try to extract the literal value from the default value type
        if (defaultValueType.flags & ts.TypeFlags.NumberLiteral) {
          // @ts-ignore - accessing value property
          schema.default = (defaultValueType as any).value;
        } else if (defaultValueType.flags & ts.TypeFlags.StringLiteral) {
          // @ts-ignore - accessing value property
          schema.default = (defaultValueType as any).value;
        } else if (defaultValueType.flags & ts.TypeFlags.BooleanLiteral) {
          // @ts-ignore - accessing intrinsicName property
          schema.default = (defaultValueType as any).intrinsicName === "true";
        } else if ((defaultValueType as any).intrinsicName === "true") {
          schema.default = true;
        } else if ((defaultValueType as any).intrinsicName === "false") {
          schema.default = false;
        } else if (defaultValueType.isLiteral && defaultValueType.isLiteral()) {
          // Handle other literal types
          const literalValue = (defaultValueType as any).value;
          if (literalValue !== undefined) {
            schema.default = literalValue;
          }
        }

        return schema;
      }
    }
  }

  // Handle Default<T, V> type via symbol check (fallback)
  // Also check if the type resolves to Default through an alias
  if (
    symbol &&
    (symbol.name === "Default" ||
      (type as any).target?.symbol?.name === "Default")
  ) {
    // This is a generic type Default<T, V>
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
      const innerType = typeRef.typeArguments[0];
      const defaultValueType = typeRef.typeArguments[1];

      // Get the schema for the inner type
      const schema = typeToJsonSchemaHelper(
        innerType,
        checker,
        typeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false, // Default inner types are never root types
      );

      // Try to extract the literal value from the default value type
      if (defaultValueType.flags & ts.TypeFlags.NumberLiteral) {
        // @ts-ignore - accessing value property
        schema.default = (defaultValueType as any).value;
      } else if (defaultValueType.flags & ts.TypeFlags.StringLiteral) {
        // @ts-ignore - accessing value property
        schema.default = (defaultValueType as any).value;
      } else if (defaultValueType.flags & ts.TypeFlags.BooleanLiteral) {
        // @ts-ignore - accessing intrinsicName property
        schema.default = (defaultValueType as any).intrinsicName === "true";
      } else if ((defaultValueType as any).intrinsicName === "true") {
        schema.default = true;
      } else if ((defaultValueType as any).intrinsicName === "false") {
        schema.default = false;
      }

      return schema;
    }
    // If we can't extract type arguments, return a permissive schema
    return { type: "object", additionalProperties: true };
  }

  // Handle object types (interfaces, type literals)
  if (type.flags & ts.TypeFlags.Object) {
    return buildObjectSchema(
      type,
      checker,
      typeNode,
      depth,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
    );
  }

  // Handle union types
  if (type.isUnion()) {
    const unionTypes = (type as ts.UnionType).types;
    // Check if it's a nullable type (T | undefined)
    const nonNullTypes = unionTypes.filter((t) =>
      !(t.flags & ts.TypeFlags.Undefined)
    );

    // Special handling for boolean | undefined (which appears as false | true | undefined)
    if (
      unionTypes.length === 3 &&
      unionTypes.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral).length ===
        2 &&
      unionTypes.filter((t) => t.flags & ts.TypeFlags.Undefined).length === 1
    ) {
      // This is boolean | undefined, return boolean schema
      return { type: "boolean" };
    }

    if (nonNullTypes.length === 1 && unionTypes.length === 2) {
      // This is an optional type, just return the non-null type schema
      return typeToJsonSchemaHelper(
        nonNullTypes[0],
        checker,
        typeNode,
        depth,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false, // union members are never root types
      );
    }
    // Otherwise, use oneOf
    return {
      oneOf: unionTypes.map((t) =>
        typeToJsonSchemaHelper(
          t,
          checker,
          typeNode,
          depth,
          newSeenTypes,
          cyclicTypes,
          definitions,
          definitionStack,
          false, // union members are never root types
        )
      ),
    };
  }

  // Default fallback - for "any" type, use a permissive schema
  return { type: "object", additionalProperties: true };
}

// Helper function to extract values from type nodes (for Default<T, V>)
function extractValueFromTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): any {
  // Handle literal type nodes
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) {
      return literal.text;
    } else if (ts.isNumericLiteral(literal)) {
      return Number(literal.text);
    } else if (literal.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    } else if (literal.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    } else if (literal.kind === ts.SyntaxKind.NullKeyword) {
      return null;
    }
  }

  // Handle tuple types (array literals in type position)
  if (ts.isTupleTypeNode(node)) {
    const values: any[] = [];
    for (const elem of node.elements) {
      const value = extractValueFromTypeNode(elem, checker);
      values.push(value);
    }
    return values;
  }

  // Handle type literals (object literals in type position)
  if (ts.isTypeLiteralNode(node)) {
    const obj: any = {};
    for (const member of node.members) {
      if (
        ts.isPropertySignature(member) && member.name &&
        ts.isIdentifier(member.name)
      ) {
        const key = member.name.text;
        if (member.type) {
          const value = extractValueFromTypeNode(member.type, checker);
          if (value !== undefined) {
            obj[key] = value;
          }
        }
      }
    }
    return obj;
  }

  // Handle array type with literal elements
  if (ts.isArrayTypeNode(node)) {
    // For array types like string[], we can't extract a default value
    return undefined;
  }

  // Handle union types (for nullable types)
  if (ts.isUnionTypeNode(node)) {
    // Check if one of the types is null
    for (const type of node.types) {
      if (type.kind === ts.SyntaxKind.NullKeyword) {
        return null;
      }
      if (type.kind === ts.SyntaxKind.UndefinedKeyword) {
        return undefined;
      }
    }
  }

  // Handle direct null/undefined keywords
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return undefined;
  }

  return undefined;
}

/**
 * First pass: Detect which types are involved in cycles
 * Returns a Set of types that have recursive references
 */
export function getCycles(
  type: ts.Type,
  checker: ts.TypeChecker,
  visiting: Set<ts.Type> = new Set(),
  cycles: Set<ts.Type> = new Set(),
): Set<ts.Type> {
  // Skip primitive types - they can't have cycles
  if (
    type.flags &
    (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean |
      ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return cycles;
  }

  // Only track types that could potentially self-reference
  if (type.flags & ts.TypeFlags.Object) {
    const symbol = type.getSymbol();

    // Use same logic as in typeToJsonSchema for consistency
    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !["Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet"]
        .includes(symbol.name);

    if (!shouldTrack) {
      // Check if it's an array type using our helper
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        getCycles(elementType, checker, visiting, cycles);
      }
      return cycles;
    }

    // Check if we're already visiting this type (cycle detected)
    if (visiting.has(type)) {
      // This type is part of a cycle
      cycles.add(type);
      // Also mark all types currently being visited as potentially cyclic
      // This ensures parent types know they contain cyclic children
      visiting.forEach((t) => {
        cycles.add(t);
      });
      return cycles;
    }

    // Add to visiting set
    visiting.add(type);

    // Check all properties
    const props = checker.getPropertiesOfType(type);

    if (props.length === 0) {
      // No properties - might be an array type
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        getCycles(elementType, checker, visiting, cycles);
      }
    } else {
      for (const prop of props) {
        // Skip symbol properties
        if (prop.getName().startsWith("__")) continue;

        let propType: ts.Type | undefined;
        try {
          propType = checker.getTypeOfSymbolAtLocation(
            prop,
            prop.valueDeclaration || prop.declarations?.[0]!,
          );
        } catch (_err) {
          try {
            logger.warn(() =>
              "getCycles: checker.getTypeOfSymbolAtLocation threw; skipping property"
            );
          } catch (_e) {
            // Swallow any logging issues to remain safe
          }
          continue;
        }

        // Check if the property has a type node we can analyze directly
        const propDecl = prop.valueDeclaration;
        if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
          // Check if it's an array type node
          if (ts.isArrayTypeNode(propDecl.type)) {
            const elementTypeNode = propDecl.type.elementType;
            let elementType: ts.Type | undefined;
            try {
              elementType = checker.getTypeFromTypeNode(elementTypeNode);
            } catch (_err) {
              try {
                logger.warn(() =>
                  "getCycles: checker.getTypeFromTypeNode threw; skipping array element type"
                );
              } catch (_e) {
                // Swallow any logging issues to remain safe
              }
              continue;
            }
            getCycles(elementType, checker, visiting, cycles);
            continue;
          }
        }

        getCycles(propType, checker, visiting, cycles);
      }
    }

    // Remove from visiting set
    visiting.delete(type);
  }

  // Handle union types
  if (type.isUnion()) {
    const unionTypes = (type as ts.UnionType).types;
    for (const unionType of unionTypes) {
      getCycles(unionType, checker, visiting, cycles);
    }
  }

  return cycles;
}

/**
 * Convert a TypeScript type to JSONSchema
 * Handles recursive types with JSON Schema $ref/definitions
 */
export function typeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): any {
  // First pass: detect cycles
  const cyclicTypes = getCycles(type, checker);

  // If no cycles, just return the simple schema
  if (cyclicTypes.size === 0) {
    return typeToJsonSchemaHelper(
      type,
      checker,
      typeNode,
      0,
      new Set(),
      undefined,
      undefined,
      new Set(),
      true,
    );
  }

  // Second pass: generate schema with definitions
  const definitions: Record<string, any> = {};
  const seenTypes = new Set<ts.Type>();

  // Generate the schema for the root type
  const rootSchema = typeToJsonSchemaHelper(
    type,
    checker,
    typeNode,
    0,
    seenTypes,
    cyclicTypes,
    definitions,
    new Set<ts.Type>(),
    true, // isRootType
  );

  // If the root type itself is cyclic, always return a top-level $ref with definitions
  if (cyclicTypes.has(type)) {
    const typeName = getStableTypeName(type, definitions);
    if (!definitions[typeName]) {
      definitions[typeName] = rootSchema;
    }
    return {
      "$ref": `#/definitions/${typeName}`,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // If we have any definitions, attach them to the root schema
  if (Object.keys(definitions).length > 0) {
    return {
      ...rootSchema,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // No cycles/definitions to attach
  return rootSchema;
}
