import ts from "typescript";
import { addCommonToolsImport, hasCommonToolsImport, removeCommonToolsImport } from "./imports.ts";

/**
 * Transformer that converts TypeScript types to JSONSchema objects.
 * Transforms `toSchema<T>()` calls into JSONSchema literals.
 */
export function createSchemaTransformer(
  program: ts.Program,
  options: { debug?: boolean } = {},
): ts.TransformerFactory<ts.SourceFile> {
  const { debug = false } = options;
  const checker = program.getTypeChecker();

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      let needsJSONSchemaImport = false;
      let hasTransformedToSchema = false;

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

          if (debug) {
            console.log(
              `[SchemaTransformer] Found toSchema<${typeArg.getText()}>() call`,
            );
          }

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

          hasTransformedToSchema = true;
          return satisfiesExpression;
        }

        return ts.visitEachChild(node, visit, context);
      };

      let result = ts.visitNode(sourceFile, visit) as ts.SourceFile;
      
      // Add JSONSchema import if needed
      if (needsJSONSchemaImport) {
        result = addCommonToolsImport(result, context.factory, "JSONSchema");
      }
      
      // Log for debugging the handler-object-literal case
      if (sourceFile.fileName.includes("handler-object-literal")) {
        console.log(`[SchemaTransformer] Processing ${sourceFile.fileName}`);
        console.log(`  - hasTransformedToSchema: ${hasTransformedToSchema}`);
        console.log(`  - hasCommonToolsImport(result, "toSchema"): ${hasCommonToolsImport(result, "toSchema")}`);
      }
      
      // Remove toSchema import if we transformed all its uses
      if (hasCommonToolsImport(result, "toSchema")) {
        // Check if toSchema is still used anywhere in the transformed code
        const stillUsesToSchema = containsToSchemaReference(result);
        
        if (debug) {
          console.log(`[SchemaTransformer] Checking toSchema import removal:`);
          console.log(`  - hasCommonToolsImport(toSchema): true`);
          console.log(`  - stillUsesToSchema: ${stillUsesToSchema}`);
        }
        
        if (!stillUsesToSchema) {
          if (debug) {
            console.log(`[SchemaTransformer] Removing toSchema import`);
          }
          result = removeCommonToolsImport(result, context.factory, "toSchema");
        }
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
  if (type.flags & ts.TypeFlags.Null) {
    return { type: "null" };
  }
  if (type.flags & ts.TypeFlags.Undefined) {
    return { type: "undefined" };
  }

  // Handle arrays
  if (type.symbol && type.symbol.name === "Array") {
    const typeRef = type as ts.TypeReference;
    if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
      return {
        type: "array",
        items: typeToJsonSchema(typeRef.typeArguments[0], checker),
      };
    }
    return { type: "array" };
  }

  // Also check if it's an array type using the checker
  const typeString = checker.typeToString(type);
  if (typeString.endsWith("[]")) {
    // Extract the element type
    const elementTypeString = typeString.slice(0, -2);
    // This is a simplified approach - in a real implementation we'd need to get the actual element type
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
        typeNode || prop.valueDeclaration!,
      );

      // Check if property is optional
      const isOptional = prop.flags & ts.SymbolFlags.Optional;
      if (!isOptional) {
        required.push(propName);
      }

      // Check if the property type is Cell<T> or Stream<T>
      const propTypeString = checker.typeToString(propType);
      let actualPropType = propType;
      let isCell = false;
      let isStream = false;

      // Check if this is a Cell<T> type
      if (propTypeString.startsWith("Cell<") && propTypeString.endsWith(">")) {
        isCell = true;
        // Extract the inner type
        const typeRef = propType as ts.TypeReference;
        if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
          actualPropType = typeRef.typeArguments[0];
        }
      } // Check if this is a Stream<T> type
      else if (
        propTypeString.startsWith("Stream<") && propTypeString.endsWith(">")
      ) {
        isStream = true;
        // Extract the inner type
        const typeRef = propType as ts.TypeReference;
        if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
          actualPropType = typeRef.typeArguments[0];
        }
      }

      // Get property schema for the actual type (unwrapped if it was Cell/Stream)
      const propSchema = typeToJsonSchema(actualPropType, checker);

      // Add asCell/asStream flags
      if (isCell) {
        propSchema.asCell = true;
      }
      if (isStream) {
        propSchema.asStream = true;
      }

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
    if (nonNullTypes.length === 1 && unionTypes.length === 2) {
      // This is an optional type, just return the non-null type schema
      return typeToJsonSchema(nonNullTypes[0], checker);
    }
    // Otherwise, use oneOf
    return {
      oneOf: unionTypes.map((t) => typeToJsonSchema(t, checker)),
    };
  }

  // Default fallback
  return { type: "any" };
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
      // Handle nested schemas that might be references
      if (key === "asStream" && value === true && schema.type) {
        // For asStream properties, we need to spread the base schema
        const baseSchema = { ...schema };
        delete baseSchema.asStream;

        return factory.createObjectLiteralExpression([
          factory.createSpreadAssignment(createSchemaAst(baseSchema, factory)),
          factory.createPropertyAssignment(
            factory.createIdentifier("asStream"),
            factory.createTrue(),
          ),
        ]);
      }

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

      if (ts.isStringLiteral(prop.initializer)) {
        result[key] = prop.initializer.text;
      } else if (ts.isNumericLiteral(prop.initializer)) {
        result[key] = Number(prop.initializer.text);
      } else if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        result[key] = true;
      } else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        result[key] = false;
      } else if (ts.isObjectLiteralExpression(prop.initializer)) {
        result[key] = evaluateObjectLiteral(prop.initializer, checker);
      } else if (ts.isArrayLiteralExpression(prop.initializer)) {
        result[key] = prop.initializer.elements.map((elem) => {
          if (ts.isStringLiteral(elem)) return elem.text;
          if (ts.isNumericLiteral(elem)) return Number(elem.text);
          if (ts.isObjectLiteralExpression(elem)) {
            return evaluateObjectLiteral(elem, checker);
          }
          return undefined;
        }).filter((x) => x !== undefined);
      }
    }
  }

  return result;
}

/**
 * Check if the source file contains any remaining references to toSchema
 * after transformation.
 */
function containsToSchemaReference(sourceFile: ts.SourceFile): boolean {
  let found = false;
  let count = 0;

  const visit: ts.Visitor = (node) => {
    if (found) return node;

    // Check for toSchema identifier references
    if (ts.isIdentifier(node) && node.text === "toSchema") {
      count++;
      // Make sure it's not part of an import declaration
      let parent = node.parent;
      while (parent) {
        if (ts.isImportDeclaration(parent)) {
          // This is part of an import, not a usage
          return node;
        }
        parent = parent.parent;
      }
      // Found a usage of toSchema outside of imports
      found = true;
      return node;
    }

    return ts.visitEachChild(node, visit, undefined);
  };

  ts.visitNode(sourceFile, visit);
  
  // Debug log for handler-object-literal
  if (sourceFile.fileName.includes("handler-object-literal")) {
    console.log(`[containsToSchemaReference] ${sourceFile.fileName}:`);
    console.log(`  - Total toSchema identifiers found: ${count}`);
    console.log(`  - Found non-import usage: ${found}`);
  }
  
  return found;
}
