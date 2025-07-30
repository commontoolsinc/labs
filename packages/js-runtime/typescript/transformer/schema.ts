import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";
import {
  addCommonToolsImport,
  hasCommonToolsImport,
  removeCommonToolsImport,
} from "./imports.ts";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: false,
  level: "debug",
});

/**
 * Transformer that converts TypeScript types to JSONSchema objects.
 * Transforms `toSchema<T>()` calls into JSONSchema literals.
 */
export function createSchemaTransformer(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      let needsJSONSchemaImport = false;

      const visit: ts.Visitor = (node) => {
        // Look for toSchema<T>() calls
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "toSchema" &&
          node.typeArguments &&
          node.typeArguments.length === 1
        ) {
          const typeArg = node.typeArguments[0];
          const type = checker.getTypeFromTypeNode(typeArg);

          logger.debug(() => {
            if (typeArg) {
              let typeText = "unknown";
              try {
                typeText = typeArg.getText();
              } catch {
                // getText() fails on synthetic nodes without source file context
              }
              return `[SchemaTransformer] Found toSchema<${typeText}>() call`;
            }
            return "[SchemaTransformer] Found toSchema call";
          });

          // Extract options from the call arguments
          const options = node.arguments[0];
          let optionsObj: any = {};
          if (options && ts.isObjectLiteralExpression(options)) {
            optionsObj = evaluateObjectLiteral(options, checker);
          }

          // Generate JSONSchema from the type
          const schema = typeToJsonSchema(type, checker, typeArg);

          // Merge with options
          const finalSchema = { ...schema, ...optionsObj };

          // Create the AST for the schema object
          const schemaAst = createSchemaAst(finalSchema, context.factory);

          // Add type assertion: as const satisfies JSONSchema
          const constAssertion = context.factory.createAsExpression(
            schemaAst,
            context.factory.createTypeReferenceNode(
              context.factory.createIdentifier("const"),
              undefined,
            ),
          );

          const satisfiesExpression = context.factory.createSatisfiesExpression(
            constAssertion,
            context.factory.createTypeReferenceNode(
              context.factory.createIdentifier("JSONSchema"),
              undefined,
            ),
          );

          // Mark that we need JSONSchema import
          if (!hasCommonToolsImport(sourceFile, "JSONSchema")) {
            needsJSONSchemaImport = true;
          }

          return satisfiesExpression;
        }

        return ts.visitEachChild(node, visit, context);
      };

      let result = ts.visitNode(sourceFile, visit) as ts.SourceFile;

      // Add JSONSchema import if needed
      if (needsJSONSchemaImport) {
        result = addCommonToolsImport(result, context.factory, "JSONSchema");
      }

      // Always remove toSchema import since it doesn't exist at runtime
      // The SchemaTransformer should have transformed all toSchema calls
      if (hasCommonToolsImport(result, "toSchema")) {
        logger.debug(() =>
          `[SchemaTransformer] Removing toSchema import (not available at runtime)`
        );
        result = removeCommonToolsImport(result, context.factory, "toSchema");
      }

      return result;
    };
  };
}

/**
 * Convert a TypeScript type to JSONSchema
 */
function typeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): any {
  // If we have a type node, check if it's a type reference to Default<T, V>
  if (typeNode && ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    if (ts.isIdentifier(typeName) && typeName.text === "Default") {
      if (typeNode.typeArguments && typeNode.typeArguments.length >= 2) {
        const innerTypeNode = typeNode.typeArguments[0];
        const defaultValueNode = typeNode.typeArguments[1];

        // Get the inner type
        const innerType = checker.getTypeFromTypeNode(innerTypeNode);
        const schema = typeToJsonSchema(innerType, checker, innerTypeNode);

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
  
  // Check if this is a Cell<T> or Stream<T> type at the top level
  const typeString = checker.typeToString(type);
  if (typeString.startsWith("Cell<") && typeString.endsWith(">")) {
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
    const schema = typeToJsonSchema(innerType, checker, innerTypeNode || typeNode);
    schema.asCell = true;
    return schema;
  }
  
  if (typeString.startsWith("Stream<") && typeString.endsWith(">")) {
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
    const schema = typeToJsonSchema(innerType, checker, innerTypeNode || typeNode);
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
        items: typeToJsonSchema(elementType, checker, elementTypeNode),
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
        items: typeToJsonSchema(elementType, checker, elementTypeNode),
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
  
  // Check for Default type using aliasSymbol (for types resolved from arrays)
  const aliasSymbol = (type as any).aliasSymbol;
  if (aliasSymbol && aliasSymbol.name === "Default") {
    const aliasTypeArguments = (type as any).aliasTypeArguments;
    if (aliasTypeArguments && aliasTypeArguments.length >= 2) {
      const innerType = aliasTypeArguments[0];
      const defaultValueType = aliasTypeArguments[1];
      
      // Get the schema for the inner type
      // Pass undefined for typeNode to avoid infinite recursion
      const schema = typeToJsonSchema(innerType, checker, undefined);
      
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
        const schema = typeToJsonSchema(innerType, checker, typeNode);

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
  if (symbol && symbol.name === "Default") {
    // This is a generic type Default<T, V>
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length >= 2) {
      const innerType = typeRef.typeArguments[0];
      const defaultValueType = typeRef.typeArguments[1];

      // Get the schema for the inner type
      const schema = typeToJsonSchema(innerType, checker, typeNode);

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
    const props = type.getProperties();
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
      const propSchema = typeToJsonSchema(
        propType,
        checker,
        propTypeNode,
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
      return typeToJsonSchema(nonNullTypes[0], checker, typeNode);
    }
    // Otherwise, use oneOf
    return {
      oneOf: unionTypes.map((t) => typeToJsonSchema(t, checker, typeNode)),
    };
  }

  // Default fallback - for "any" type, use a permissive schema
  return { type: "object", additionalProperties: true };
}

/**
 * Create AST for a schema object
 */
function createSchemaAst(schema: any, factory: ts.NodeFactory): ts.Expression {
  if (schema === null) {
    return factory.createNull();
  }

  if (typeof schema === "string") {
    return factory.createStringLiteral(schema);
  }

  if (typeof schema === "number") {
    return factory.createNumericLiteral(schema);
  }

  if (typeof schema === "boolean") {
    return schema ? factory.createTrue() : factory.createFalse();
  }

  if (Array.isArray(schema)) {
    return factory.createArrayLiteralExpression(
      schema.map((item) => createSchemaAst(item, factory)),
    );
  }

  if (typeof schema === "object") {
    const properties: ts.PropertyAssignment[] = [];

    for (const [key, value] of Object.entries(schema)) {
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(key),
          createSchemaAst(value, factory),
        ),
      );
    }

    return factory.createObjectLiteralExpression(properties, true);
  }

  return factory.createIdentifier("undefined");
}

/**
 * Evaluate an object literal to extract its values
 */
function evaluateObjectLiteral(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): any {
  const result: any = {};

  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const key = prop.name.text;
      const value = evaluateExpression(prop.initializer, checker);
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return result;
}

// Helper function to evaluate any expression to a literal value
function evaluateExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
): any {
  if (ts.isStringLiteral(node)) {
    return node.text;
  } else if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  } else if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  } else if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return undefined;
  } else if (ts.isObjectLiteralExpression(node)) {
    return evaluateObjectLiteral(node, checker);
  } else if (ts.isArrayLiteralExpression(node)) {
    const values: any[] = [];
    for (const elem of node.elements) {
      const value = evaluateExpression(elem, checker);
      // Keep undefined values in arrays
      values.push(value);
    }
    return values;
  }
  // Return a special marker for unknown expressions
  return undefined;
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
