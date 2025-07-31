import ts from "typescript";
import {
  addCommonToolsImport,
  hasCommonToolsImport,
  removeCommonToolsImport,
} from "./imports.ts";
import { typeToJsonSchema } from "./schema-generator.ts";

export interface SchemaTransformerOptions {
  logger?: (message: string) => void;
}

/**
 * Transformer that converts TypeScript types to JSONSchema objects.
 * Transforms `toSchema<T>()` calls into JSONSchema literals.
 */
export function createSchemaTransformer(
  program: ts.Program,
  options: SchemaTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const logger = options.logger;

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

          if (logger && typeArg) {
            let typeText = "unknown";
            try {
              typeText = typeArg.getText();
            } catch {
              // getText() fails on synthetic nodes without source file context
            }
            logger(`[SchemaTransformer] Found toSchema<${typeText}>() call`);
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
        if (logger) {
          logger(
            `[SchemaTransformer] Removing toSchema import (not available at runtime)`,
          );
        }
        result = removeCommonToolsImport(result, context.factory, "toSchema");
      }

      return result;
    };
  };
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
