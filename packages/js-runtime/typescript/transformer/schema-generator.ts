import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: true,
  level: "debug",
});

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
  processingForDefinitions: Set<ts.Type> = new Set(), // Track types being processed for definitions
): any {
  // Prevent deep recursion
  if (depth > 50) {
    logger.debug(`typeToJsonSchemaHelper: Max depth reached at ${depth}`);
    return {
      type: "object",
      additionalProperties: true,
      $comment: "max depth reached",
    };
  }

  const typeId = (type as any).id || "no-id";
  let typeName = "anonymous";
  try {
    typeName = type.symbol?.name || "anonymous";
  } catch (e) {
    // Accessing symbol.name can cause stack overflow in some cases
    logger.debug(`typeToJsonSchemaHelper: Error accessing symbol name: ${e}`);
  }
  logger.debug(
    `typeToJsonSchemaHelper: Processing ${typeName} (id: ${typeId}) at depth ${depth}, isRoot=${isRootType}`,
  );
  logger.debug(`  seenTypes has ${seenTypes.size} types`);
  for (const seen of seenTypes) {
    logger.debug(
      `    - ${seen.symbol?.name || "anonymous"} (id: ${
        (seen as any).id || "no-id"
      })`,
    );
  }

  // Check if we already have a complete definition for this type
  // This is important for handling recursive types that we've already processed
  if (
    definitions && typeName !== "anonymous" && definitions[typeName] &&
    definitions[typeName].$comment !== "placeholder" && !isRootType
  ) {
    logger.debug(
      `typeToJsonSchemaHelper: Found complete definition for ${typeName}, returning $ref`,
    );
    return { "$ref": `#/definitions/${typeName}` };
  }

  // If cyclicTypes is provided, check if this is a cyclic type
  if (cyclicTypes && cyclicTypes.has(type) && definitions) {
    let cyclicTypeName: string;
    try {
      cyclicTypeName = type.symbol?.name ||
        `Type${Object.keys(definitions).length}`;
    } catch (e) {
      cyclicTypeName = `Type${Object.keys(definitions).length}`;
    }
    logger.debug(`typeToJsonSchemaHelper: ${cyclicTypeName} is in cyclicTypes`);

    // If we're currently processing this type for definitions, return a $ref to avoid infinite recursion
    if (processingForDefinitions.has(type)) {
      logger.debug(
        `typeToJsonSchemaHelper: Currently processing ${cyclicTypeName} for definitions, returning $ref`,
      );
      return { "$ref": `#/definitions/${cyclicTypeName}` };
    }

    // If we've already seen this type, return a $ref
    if (seenTypes.has(type)) {
      logger.debug(
        `typeToJsonSchemaHelper: Already seen ${cyclicTypeName}, returning $ref`,
      );
      return { "$ref": `#/definitions/${cyclicTypeName}` };
    }

    // Also check if we already have a definition for this type name
    // This handles cases where type identity comparison might fail
    if (definitions[cyclicTypeName]) {
      logger.debug(
        `typeToJsonSchemaHelper: Definition already exists for ${cyclicTypeName}, returning $ref`,
      );
      return { "$ref": `#/definitions/${cyclicTypeName}` };
    }

    // First time seeing this cyclic type - generate the full schema
    // but we'll add it to definitions and return a $ref if this is not the root
    if (!isRootType) {
      // Mark that we're processing this type BEFORE recursing
      seenTypes.add(type);
      processingForDefinitions.add(type); // Mark as being processed for definitions
      logger.debug(
        `typeToJsonSchemaHelper: Adding ${cyclicTypeName} to seenTypes and processing for definitions`,
      );

      // Add a placeholder to definitions first to prevent infinite recursion
      definitions[cyclicTypeName] = { type: "object", $comment: "placeholder" };

      // Generate the full schema - we need to process this type without the cyclic check
      // to get its actual structure. We'll do this by temporarily marking it as non-cyclic.
      const tempCyclicTypes = new Set(cyclicTypes);
      tempCyclicTypes.delete(type); // Remove this type so it gets processed normally

      // Also temporarily remove from seenTypes so it can be processed
      const tempSeenTypes = new Set(seenTypes);
      tempSeenTypes.delete(type);

      const schema = typeToJsonSchemaHelper(
        type,
        checker,
        typeNode,
        depth,
        tempSeenTypes, // Use temp set without this type
        tempCyclicTypes, // Use temp set without this type
        definitions,
        false,
        processingForDefinitions, // Pass the tracking set
      );

      // Remove from processing set after we're done
      processingForDefinitions.delete(type);

      // Replace placeholder with actual schema
      definitions[cyclicTypeName] = schema;
      logger.debug(
        `typeToJsonSchemaHelper: Added ${cyclicTypeName} to definitions`,
      );

      // Return a reference
      return { "$ref": `#/definitions/${cyclicTypeName}` };
    } else {
      // If this is the root type and it's cyclic, we still need to track it
      // to avoid infinite recursion when we encounter it again
      seenTypes.add(type);
    }
  }

  // Check if we've seen this type before (for cycle detection)
  // But don't return $ref if this is the root type being processed
  if (seenTypes.has(type) && !isRootType) {
    // If we have definitions, return a proper $ref
    if (definitions && typeName !== "anonymous") {
      logger.debug(
        `typeToJsonSchemaHelper: Type ${typeName} already in seenTypes, returning $ref`,
      );
      return { "$ref": `#/definitions/${typeName}` };
    }
    // Otherwise return a placeholder (old behavior)
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
      !["Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet"]
        .includes(symbol.name);

    if (shouldTrack) {
      // Only add if not already in seenTypes (important for cyclic types)
      if (!seenTypes.has(type)) {
        newSeenTypes.add(type);
      }
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
              false, // Default inner types are never root types
              processingForDefinitions,
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
            false, // Default inner types are never root types
            processingForDefinitions,
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
            false, // Default inner types are never root types
            processingForDefinitions,
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
      false, // Cell inner types are never root types
      processingForDefinitions,
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
      false, // Stream inner types are never root types
      processingForDefinitions,
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
        false, // array elements are never root types
        processingForDefinitions,
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
        false, // array elements are never root types
        processingForDefinitions,
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
          false, // Default inner types are never root types
          processingForDefinitions,
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
        false, // Default inner types are never root types
        processingForDefinitions,
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

      // Check if property is optional
      const isOptional = prop.flags & ts.SymbolFlags.Optional;
      if (!isOptional) {
        required.push(propName);
      }

      // Check if the property has a type node we can analyze directly
      const propDecl = prop.valueDeclaration;
      let propTypeNode: ts.TypeNode | undefined;
      let propType: ts.Type | undefined;

      if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
        propTypeNode = propDecl.type;

        // For type references in cyclic contexts, handle them specially
        if (cyclicTypes && ts.isTypeReferenceNode(propDecl.type)) {
          const typeRef = propDecl.type;
          const typeName = typeRef.typeName;
          if (ts.isIdentifier(typeName)) {
            const referencedSymbol = checker.getSymbolAtLocation(typeName);
            if (referencedSymbol) {
              // Check if this symbol is one of our known cyclic types by name
              const refTypeName = referencedSymbol.name;

              // For cyclic types, we can skip trying to get the type and just generate a ref
              // This avoids the stack overflow in getDeclaredTypeOfSymbol
              let isCyclicRef = false;

              // Check if any cyclic type has this symbol name
              for (const cyclicType of cyclicTypes) {
                if (cyclicType.symbol?.name === refTypeName) {
                  isCyclicRef = true;
                  break;
                }
              }

              if (isCyclicRef) {
                // This is a reference to a cyclic type
                properties[propName] = {
                  "$ref": `#/definitions/${refTypeName}`,
                };

                // Make sure the referenced type is in definitions
                if (definitions && !definitions[refTypeName]) {
                  // We need to find the actual type to process it
                  // But we can't use getDeclaredTypeOfSymbol as it causes stack overflow
                  // Instead, mark that we need to process this type
                  for (const cyclicType of cyclicTypes) {
                    if (cyclicType.symbol?.name === refTypeName) {
                      // Process the cyclic type to add it to definitions
                      typeToJsonSchemaHelper(
                        cyclicType,
                        checker,
                        propTypeNode,
                        depth + 1,
                        newSeenTypes,
                        cyclicTypes,
                        definitions,
                        false,
                        processingForDefinitions,
                      );
                      break;
                    }
                  }
                }
                continue;
              }

              // Not a cyclic reference, try to get the type normally
              try {
                propType = checker.getDeclaredTypeOfSymbol(referencedSymbol);
              } catch (error) {
                logger.debug(
                  `Error getting declared type for ${typeName.text}: ${error}`,
                );
              }
            }
          }
        }
      }

      // If we haven't determined the type yet, get it the normal way
      if (!propType) {
        try {
          logger.debug(
            `typeToJsonSchemaHelper: Getting type for property ${propName}`,
          );
          propType = checker.getTypeOfSymbolAtLocation(
            prop,
            prop.valueDeclaration || typeNode || prop.declarations?.[0]!,
          );
        } catch (error) {
          logger.debug(`Error getting type of property ${propName}: ${error}`);
          // If we can't get the type, use a permissive schema
          properties[propName] = { type: "object", additionalProperties: true };
          continue;
        }
      }

      // Get property schema - let typeToJsonSchema handle all wrapper types
      logger.debug(
        `typeToJsonSchemaHelper: Processing property ${propName} of type ${
          propType.symbol?.name || "anonymous"
        }`,
      );
      const propSchema = typeToJsonSchemaHelper(
        propType,
        checker,
        propTypeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
        false, // nested types are never root types
        processingForDefinitions,
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
        false, // union members are never root types
        processingForDefinitions,
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
          false, // union members are never root types
          processingForDefinitions,
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
  depth: number = 0,
): Set<ts.Type> {
  logger.debug(
    `getCycles: Processing type ${
      type.symbol?.name || "anonymous"
    } at depth ${depth}`,
  );
  // Prevent deep recursion that could cause stack overflow
  if (depth > 100) {
    logger.debug("getCycles: Max depth reached, stopping recursion");
    return cycles;
  }

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
        getCycles(elementType, checker, visiting, cycles, depth + 1);
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
        getCycles(elementType, checker, visiting, cycles, depth + 1);
      }
    } else {
      for (const prop of props) {
        // Skip symbol properties
        if (prop.getName().startsWith("__")) continue;

        try {
          // First try to get the type from the property's type node if available
          const propDecl = prop.valueDeclaration;
          if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
            // Check if it's an array type node
            if (ts.isArrayTypeNode(propDecl.type)) {
              const elementTypeNode = propDecl.type.elementType;
              const elementType = checker.getTypeFromTypeNode(elementTypeNode);
              getCycles(elementType, checker, visiting, cycles, depth + 1);
              continue;
            }

            // For type references, we can analyze the type node directly
            if (ts.isTypeReferenceNode(propDecl.type)) {
              const typeRef = propDecl.type;
              const typeName = typeRef.typeName;
              if (ts.isIdentifier(typeName)) {
                // Check if this references a type we're already visiting
                const referencedSymbol = checker.getSymbolAtLocation(typeName);
                if (referencedSymbol) {
                  const referencedType = checker.getDeclaredTypeOfSymbol(
                    referencedSymbol,
                  );
                  if (referencedType) {
                    getCycles(
                      referencedType,
                      checker,
                      visiting,
                      cycles,
                      depth + 1,
                    );
                    continue;
                  }
                }
              }
            }
          }

          // Fallback to getTypeOfSymbolAtLocation if we couldn't analyze the type node
          try {
            const propType = checker.getTypeOfSymbolAtLocation(
              prop,
              prop.valueDeclaration || prop.declarations?.[0]!,
            );
            getCycles(propType, checker, visiting, cycles, depth + 1);
          } catch (stackError) {
            logger.debug(
              `getCycles: Stack overflow in getTypeOfSymbolAtLocation for ${prop.getName()}: ${stackError}`,
            );
            // This type and its containing type are problematic
            cycles.add(type);
            // Try to find the referenced type by name in our visiting set
            const propDecl = prop.valueDeclaration;
            if (
              propDecl && ts.isPropertySignature(propDecl) && propDecl.type &&
              ts.isTypeReferenceNode(propDecl.type)
            ) {
              const typeName = propDecl.type.typeName;
              if (ts.isIdentifier(typeName)) {
                // Mark any type with this name as cyclic
                visiting.forEach((visitingType) => {
                  if (visitingType.symbol?.name === typeName.text) {
                    cycles.add(visitingType);
                  }
                });
              }
            }
          }
        } catch (error) {
          // If we get a stack overflow or other error, log it and continue
          logger.debug(
            `getCycles: Error processing property ${prop.getName()}: ${error}`,
          );
          // Mark the containing type as potentially problematic
          cycles.add(type);
        }
      }
    }

    // Remove from visiting set
    visiting.delete(type);
  }

  // Handle union types
  if (type.isUnion()) {
    const unionTypes = (type as ts.UnionType).types;
    for (const unionType of unionTypes) {
      getCycles(unionType, checker, visiting, cycles, depth + 1);
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
  logger.debug(
    `typeToJsonSchema: Starting for type ${type.symbol?.name || "anonymous"}`,
  );

  // First pass: detect cycles
  const cyclicTypes = getCycles(type, checker);
  logger.debug(`typeToJsonSchema: Found ${cyclicTypes.size} cyclic types`);
  cyclicTypes.forEach((t) =>
    logger.debug(`  - ${t.symbol?.name || "anonymous"}`)
  );

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
      true,
      new Set(),
    );
  }

  // Second pass: generate schema with definitions
  const definitions: Record<string, any> = {};
  const seenTypes = new Set<ts.Type>();

  // Generate the schema for the root type
  logger.debug(`typeToJsonSchema: Generating root schema`);
  const rootSchema = typeToJsonSchemaHelper(
    type,
    checker,
    typeNode,
    0,
    seenTypes,
    cyclicTypes,
    definitions,
    true, // isRootType
    new Set(), // processingForDefinitions
  );
  logger.debug(
    `typeToJsonSchema: Root schema generated, definitions: ${
      Object.keys(definitions).join(", ")
    }`,
  );

  // Check if we need to wrap the schema
  // We need to wrap if:
  // 1. We have definitions, OR
  // 2. The root type itself is cyclic (it will need to be in definitions)
  if (Object.keys(definitions).length > 0 || cyclicTypes.has(type)) {
    // If the root type itself is cyclic, add it to definitions and return a $ref
    if (cyclicTypes.has(type)) {
      const typeName = type.symbol?.name || "Type0";

      // Only add to definitions if not already there
      if (!definitions[typeName]) {
        definitions[typeName] = rootSchema;
      }

      return {
        "$ref": `#/definitions/${typeName}`,
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": definitions,
      };
    }

    // Otherwise, return the root schema with definitions
    return {
      ...rootSchema,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // No cycles, no definitions needed
  return rootSchema;
}
