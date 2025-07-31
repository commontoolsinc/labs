import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: false,
  level: "debug",
});

/**
 * Helper to extract array element type using multiple detection methods
 */
function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const typeString = checker.typeToString(type);

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
  const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (elementType) {
    return elementType;
  }

  return undefined;
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
  isRootType: boolean = false,
): any {
  // If cyclicTypes is provided, check if this is a cyclic type
  if (cyclicTypes && cyclicTypes.has(type) && definitions) {
    const typeName = type.symbol?.name ||
      `Type${Object.keys(definitions).length}`;

    // If we've already seen this type, return a $ref
    if (seenTypes.has(type)) {
      return { "$ref": `#/definitions/${typeName}` };
    }

    // First time seeing this cyclic type - generate the full schema
    // but we'll add it to definitions and return a $ref if this is not the root
    if (!isRootType) {
      // Check if we already have a definition for this type
      if (definitions[typeName]) {
        return { "$ref": `#/definitions/${typeName}` };
      }

      // Mark that we're processing this type
      seenTypes.add(type);

      // Generate the full schema WITHOUT checking for cycles again
      // We temporarily remove this type from cyclicTypes to avoid infinite recursion
      const tempCyclicTypes = new Set(cyclicTypes);
      tempCyclicTypes.delete(type);

      const schema = typeToJsonSchemaHelper(
        type,
        checker,
        typeNode,
        depth,
        seenTypes,
        tempCyclicTypes,
        definitions,
        false,
      );

      // Add to definitions
      definitions[typeName] = schema;

      // Return a reference
      return { "$ref": `#/definitions/${typeName}` };
    }
  }

  // Old cycle detection for when cyclicTypes is not provided
  if (!cyclicTypes && seenTypes.has(type)) {
    return {
      type: "object",
      additionalProperties: true,
      $comment: "Recursive type detected - placeholder schema",
    };
  }

  // Create a new set with this type added for recursive calls
  const newSeenTypes = new Set(seenTypes);

  // Only add interface/class types to seenTypes - only these can cause recursive cycles
  // Skip arrays, built-in types, and other types that can't self-reference
  if (type.flags & ts.TypeFlags.Object) {
    const symbol = type.getSymbol();
    const typeString = checker.typeToString(type);

    // Only track types that could potentially self-reference:
    // - Has a symbol (named type)
    // - Is an interface or class
    // - Not an array type
    // - Not a built-in type
    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !typeString.endsWith("[]") &&
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
      const symbol = checker.getSymbolAtLocation(typeName);
      const resolvedType = checker.getTypeFromTypeNode(typeNode);

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
        isDefaultAlias ||
        (symbol &&
          checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol))
            .startsWith("Default<"));

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
  const typeString = checker.typeToString(type);

  // Check for Cell type by symbol name (handles type aliases)
  if (
    type.symbol?.name === "Cell" ||
    (typeString.startsWith("Cell<") && typeString.endsWith(">"))
  ) {
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
    );
    schema.asCell = true;
    return schema;
  }

  // Check for Stream type by symbol name (handles type aliases)
  if (
    type.symbol?.name === "Stream" ||
    (typeString.startsWith("Stream<") && typeString.endsWith(">"))
  ) {
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
    const properties: any = {};
    const required: string[] = [];

    // Get all properties (including inherited ones)
    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const propName = prop.getName();

      // Skip symbol properties
      if (propName.startsWith("__")) continue;

      const propType = checker.getTypeOfSymbolAtLocation(
        prop,
        prop.valueDeclaration || typeNode || prop.declarations?.[0]!,
      );

      // Check if property is optional
      const isOptional = prop.flags & ts.SymbolFlags.Optional;
      if (!isOptional) {
        required.push(propName);
      }

      // Check if the property has a type node we can analyze directly
      const propDecl = prop.valueDeclaration;
      let propTypeNode: ts.TypeNode | undefined;
      if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
        propTypeNode = propDecl.type;
      }

      // Get property schema - let typeToJsonSchema handle all wrapper types
      const propSchema = typeToJsonSchemaHelper(
        propType,
        checker,
        propTypeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
      );

      properties[propName] = propSchema;
    }

    const schema: any = {
      type: "object",
      properties,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    return schema;
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
    const typeString = checker.typeToString(type);

    // Use same logic as in typeToJsonSchema for consistency
    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !typeString.endsWith("[]") &&
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
      // Add this type and all types in the current path to cycles
      cycles.add(type);
      // Only add tracked types from the visiting path
      visiting.forEach((t) => {
        const sym = t.getSymbol();
        if (
          sym &&
          (sym.flags &
            (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
              ts.SymbolFlags.TypeAlias))
        ) {
          cycles.add(t);
        }
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

        const propType = checker.getTypeOfSymbolAtLocation(
          prop,
          prop.valueDeclaration || prop.declarations?.[0]!,
        );

        // Check if the property has a type node we can analyze directly
        const propDecl = prop.valueDeclaration;
        if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
          // Check if it's an array type node
          if (ts.isArrayTypeNode(propDecl.type)) {
            const elementTypeNode = propDecl.type.elementType;
            const elementType = checker.getTypeFromTypeNode(elementTypeNode);
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
    return typeToJsonSchemaHelper(type, checker, typeNode);
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
    true, // isRootType
  );

  // If the root type itself is cyclic, we need to add it to definitions
  // and return a $ref structure
  if (cyclicTypes.has(type)) {
    const typeName = type.symbol?.name || "Type0";
    definitions[typeName] = rootSchema;

    return {
      "$ref": `#/definitions/${typeName}`,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // If only nested types are cyclic, return the root schema with definitions
  if (Object.keys(definitions).length > 0) {
    return {
      ...rootSchema,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // Shouldn't reach here, but just in case
  return rootSchema;
}
