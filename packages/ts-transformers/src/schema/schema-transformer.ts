import ts from "typescript";
import {
  addCommonToolsImport,
  hasCommonToolsImport,
  removeCommonToolsImport,
} from "../core/common-tools-imports.ts";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";

export interface SchemaTransformerOptions {
  logger?: (message: string) => void;
}

export function createSchemaTransformer(
  program: ts.Program,
  options: SchemaTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const logger = options.logger;
  const generateSchema = createSchemaTransformerV2();

  return (context: ts.TransformationContext) => (sourceFile: ts.SourceFile) => {
    let needsJSONSchemaImport = false;

    const visit: ts.Visitor = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "toSchema" &&
        node.typeArguments &&
        node.typeArguments.length === 1
      ) {
        const typeArg = node.typeArguments[0];
        if (!typeArg) {
          return ts.visitEachChild(node, visit, context);
        }
        const type = checker.getTypeFromTypeNode(typeArg);

        if (logger) {
          let typeText = "unknown";
          try {
            typeText = typeArg.getText();
          } catch {
            // synthetic nodes may not support getText(); ignore
          }
          logger(`[SchemaTransformer] Found toSchema<${typeText}>() call`);
        }

        const arg0 = node.arguments[0];
        let optionsObj: Record<string, unknown> = {};
        if (arg0 && ts.isObjectLiteralExpression(arg0)) {
          optionsObj = evaluateObjectLiteral(arg0, checker);
        }

        const schema = generateSchema(type, checker, typeArg);
        const finalSchema = { ...schema, ...optionsObj };
        const schemaAst = createSchemaAst(finalSchema, context.factory);

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

        if (!hasCommonToolsImport(sourceFile, "JSONSchema")) {
          needsJSONSchemaImport = true;
        }

        return satisfiesExpression;
      }

      return ts.visitEachChild(node, visit, context);
    };

    let result = ts.visitNode(sourceFile, visit) as ts.SourceFile;

    if (needsJSONSchemaImport) {
      result = addCommonToolsImport(result, context.factory, "JSONSchema");
    }

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
}

function createSchemaAst(
  schema: unknown,
  factory: ts.NodeFactory,
): ts.Expression {
  if (schema === null) return factory.createNull();
  if (typeof schema === "string") return factory.createStringLiteral(schema);
  if (typeof schema === "number") return factory.createNumericLiteral(schema);
  if (typeof schema === "boolean") {
    return schema ? factory.createTrue() : factory.createFalse();
  }
  if (Array.isArray(schema)) {
    return factory.createArrayLiteralExpression(
      schema.map((item) => createSchemaAst(item, factory)),
    );
  }
  if (typeof schema === "object") {
    const properties = Object.entries(schema as Record<string, unknown>).map((
      [key, value],
    ) =>
      factory.createPropertyAssignment(
        factory.createIdentifier(key),
        createSchemaAst(value, factory),
      )
    );
    return factory.createObjectLiteralExpression(properties, true);
  }
  return factory.createIdentifier("undefined");
}

function evaluateObjectLiteral(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const value = evaluateExpression(prop.initializer, checker);
      if (value !== undefined) {
        result[prop.name.text] = value;
      }
    }
  }
  return result;
}

function evaluateExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (ts.isObjectLiteralExpression(node)) {
    return evaluateObjectLiteral(node, checker);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => evaluateExpression(element, checker));
  }
  const constantValue = checker.getConstantValue(
    node as ts.PropertyAccessExpression,
  );
  if (constantValue !== undefined) return constantValue;
  return undefined;
}
