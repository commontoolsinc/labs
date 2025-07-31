import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: false,
  level: "debug",
});

/**
 * Convert a TypeScript type to JSONSchema
 */
export function typeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
  depth: number = 0,
  seenTypes: Set<ts.Type> = new Set(),
): any {
  // Check if we've already seen this type (cycle detection)
  if (seenTypes.has(type)) {
    logger.debug(() => `Detected cycle for type: ${type.symbol?.name || "anonymous"} (${checker.typeToString(type)})`);
    return { 
      type: "object", 
      additionalProperties: true,
      $comment: "Recursive type detected - placeholder schema"
    };
  }
  
  // Create a new set with this type added for recursive calls
  const newSeenTypes = new Set(seenTypes);
  newSeenTypes.add(type);
  
  // Log the type we're processing with indentation to show depth
  const indent = "  ".repeat(depth);
  logger.debug(() => `${indent}Processing type: ${type.symbol?.name || "anonymous"} (${checker.typeToString(type)})`);
  
  // If we have a type node, check if it's a type reference to Default<T, V>
  if (typeNode && ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    // Check if this is Default or a type that resolves to Default
    if (ts.isIdentifier(typeName)) {
      // Check if the resolved type is Default
      const symbol = checker.getSymbolAtLocation(typeName);
      const resolvedType = checker.getTypeFromTypeNode(typeNode);
      
      logger.debug(() => `Type reference: ${typeName.text}, symbol: ${symbol?.name}, aliasSymbol: ${(resolvedType as any).aliasSymbol?.name}`);
      
      // Check if the symbol is a type alias that resolves to Default
      let declaredType: ts.Type | undefined;
      let isDefaultAlias = false;
      if (symbol && symbol.flags & ts.SymbolFlags.TypeAlias) {
        // Get the type alias declaration to check what it aliases to
        const aliasDecl = symbol.declarations?.[0];
        if (aliasDecl && ts.isTypeAliasDeclaration(aliasDecl) && aliasDecl.type) {
          // Check if the type node is a reference to Default
          if (ts.isTypeReferenceNode(aliasDecl.type) && 
              ts.isIdentifier(aliasDecl.type.typeName) && 
              aliasDecl.type.typeName.text === "Default") {
            isDefaultAlias = true;
            logger.debug(() => `Type alias ${symbol.name} is an alias to Default`);
          }
        }
        declaredType = checker.getDeclaredTypeOfSymbol(symbol);
        logger.debug(() => `Type alias ${symbol.name} resolves to: ${declaredType ? checker.typeToString(declaredType) : 'undefined'}`);
      }
      
      const isDefaultType = typeName.text === "Default" || 
                           (resolvedType as any).target?.symbol?.name === "Default" ||
                           resolvedType.symbol?.name === "Default" ||
                           (resolvedType as any).aliasSymbol?.name === "Default" ||
                           (declaredType && (declaredType as any).aliasSymbol?.name === "Default") ||
                           isDefaultAlias ||
                           (symbol && checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol)).startsWith("Default<"));
      
      
      if (isDefaultType) {
        logger.debug(() => `Found Default type alias: ${typeName.text}, resolved type: ${checker.typeToString(resolvedType)}`);
        
        // For type aliases that resolve to Default, we need to get the instantiated type
        // The resolvedType is the final type (e.g., string), but we need the Default<string, "hello"> type
        if (isDefaultAlias) {
          logger.debug(() => `Processing Default type alias with ${typeNode.typeArguments?.length ?? 0} type arguments`);
          // This is a type alias to Default - we need to instantiate it with the type arguments
          const typeArgs = typeNode.typeArguments;
          if (typeArgs && typeArgs.length >= 2) {
            const innerTypeNode = typeArgs[0];
            const defaultValueNode = typeArgs[1];
            
            logger.debug(() => `Default alias: inner type = ${innerTypeNode.getText()}, default = ${defaultValueNode.getText()}`);
            
            // Get the inner type
            const innerType = checker.getTypeFromTypeNode(innerTypeNode);
            const schema = typeToJsonSchema(innerType, checker, innerTypeNode, depth + 1, newSeenTypes);
            
            // Extract the default value from the type node
            const defaultValue = extractValueFromTypeNode(defaultValueNode, checker);
            logger.debug(() => `Extracted default value: ${JSON.stringify(defaultValue)}`);
            if (defaultValue !== undefined) {
              schema.default = defaultValue;
            }
            
            return schema;
          }
        }
        
        // For type aliases, we need to check if the resolved type has type arguments
        const typeRef = resolvedType as ts.TypeReference;
        logger.debug(() => `Type arguments: ${typeRef.typeArguments?.length ?? 0}`);
        if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
          const innerType = typeRef.typeArguments[0];
          const defaultValueType = typeRef.typeArguments[1];
          
          // Get the schema for the inner type
          const schema = typeToJsonSchema(innerType, checker, typeNode, depth + 1, newSeenTypes);
          
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
        } else if (typeNode.typeArguments && typeNode.typeArguments.length >= 2) {
          // Fallback for direct Default<T, V> usage
          const innerTypeNode = typeNode.typeArguments[0];
          const defaultValueNode = typeNode.typeArguments[1];

          // Get the inner type
          const innerType = checker.getTypeFromTypeNode(innerTypeNode);
          const schema = typeToJsonSchema(innerType, checker, innerTypeNode, depth + 1, seenTypes);

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
  if (type.symbol?.name === "Cell" || (typeString.startsWith("Cell<") && typeString.endsWith(">"))) {
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
    if (typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      innerTypeNode = typeNode.typeArguments[0];
    }
    const schema = typeToJsonSchema(innerType, checker, innerTypeNode || typeNode, depth + 1, newSeenTypes);
    schema.asCell = true;
    return schema;
  }
  
  // Check for Stream type by symbol name (handles type aliases)
  if (type.symbol?.name === "Stream" || (typeString.startsWith("Stream<") && typeString.endsWith(">"))) {
    // This is a Stream<T> type
    let innerType = type;
    
    // Extract the inner type
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
      innerType = typeRef.typeArguments[0];
    }
    
    // Get schema for the inner type
    let innerTypeNode: ts.TypeNode | undefined;
    if (typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      innerTypeNode = typeNode.typeArguments[0];
    }
    const schema = typeToJsonSchema(innerType, checker, innerTypeNode || typeNode, depth + 1, newSeenTypes);
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

  // Handle arrays
  if (type.symbol && type.symbol.name === "Array") {
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
      const elementType = typeRef.typeArguments[0];
      
      // Extract element type node if we have a type node
      let elementTypeNode: ts.TypeNode | undefined;
      if (typeNode && ts.isTypeReferenceNode(typeNode) && 
          typeNode.typeName && typeNode.typeArguments && 
          typeNode.typeArguments.length > 0) {
        elementTypeNode = typeNode.typeArguments[0];
      }
      
      // Let typeToJsonSchema handle all wrapper types (Default, Cell, Stream)
      return {
        type: "array",
        items: typeToJsonSchema(elementType, checker, elementTypeNode, depth + 1, newSeenTypes),
      };
    }
    return { type: "array" };
  }

  // Also check if it's an array type using the checker
  if (typeString.endsWith("[]")) {
    // Try to get the element type of the array
    // For arrays, we need to check if it has a numeric index signature
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    
    if (elementType) {
      // Extract element type node if we have an array type node
      let elementTypeNode: ts.TypeNode | undefined;
      if (typeNode && ts.isArrayTypeNode(typeNode)) {
        elementTypeNode = typeNode.elementType;
      }
      
      // Let typeToJsonSchema handle all wrapper types (Default, Cell, Stream)
      return {
        type: "array",
        items: typeToJsonSchema(elementType, checker, elementTypeNode, depth + 1, newSeenTypes),
      };
    }
    
    // Fallback to string parsing if we can't get element type
    const elementTypeString = typeString.slice(0, -2);
    if (elementTypeString === "string") {
      return { type: "array", items: { type: "string" } };
    } else if (elementTypeString === "number") {
      return { type: "array", items: { type: "number" } };
    } else if (elementTypeString === "boolean") {
      return { type: "array", items: { type: "boolean" } };
    }
    return { type: "array" };
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
        const schema = typeToJsonSchema(innerType, checker, typeNode, depth + 1, newSeenTypes);

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
        
        // Debug: log if we couldn't extract default
        logger.debug(() => `Default type extraction - Type: ${checker.typeToString(type)}, Default value type flags: ${defaultValueType.flags}, Value extracted: ${schema.default}`);
        

        return schema;
      }
    }
  }

  // Handle Default<T, V> type via symbol check (fallback)
  // Also check if the type resolves to Default through an alias
  if (symbol && (symbol.name === "Default" || (type as any).target?.symbol?.name === "Default")) {
    // This is a generic type Default<T, V>
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
      const innerType = typeRef.typeArguments[0];
      const defaultValueType = typeRef.typeArguments[1];

      // Get the schema for the inner type
      const schema = typeToJsonSchema(innerType, checker, typeNode, depth + 1, newSeenTypes);

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
    logger.debug(() => `${indent}Processing object type properties for: ${type.symbol?.name || "anonymous"}`);
    const properties: any = {};
    const required: string[] = [];

    // Get all properties (including inherited ones)
    const props = type.getProperties();
    for (const prop of props) {
      const propName = prop.getName();
      logger.debug(() => `${indent}  Processing property: ${propName}`);

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
      const propSchema = typeToJsonSchema(
        propType,
        checker,
        propTypeNode,
        depth + 1,
        newSeenTypes,
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
      return typeToJsonSchema(nonNullTypes[0], checker, typeNode, depth, newSeenTypes);
    }
    // Otherwise, use oneOf
    return {
      oneOf: unionTypes.map((t) => typeToJsonSchema(t, checker, typeNode, depth, newSeenTypes)),
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