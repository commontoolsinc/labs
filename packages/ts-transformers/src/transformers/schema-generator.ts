import ts from "typescript";
import {
  CT_HELPERS_IDENTIFIER,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";
import { createSchemaTransformerV2 } from "@commontools/schema-generator";

let generateSchema: ReturnType<typeof createSchemaTransformerV2> | undefined;

export class SchemaGeneratorTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    if (!generateSchema) generateSchema = createSchemaTransformerV2();
    const { sourceFile, tsContext: transformation, checker } = context;
    const { logger, typeRegistry } = context.options;

    const visit: ts.Visitor = (node) => {
      if (isToSchemaNode(node)) {
        const typeArg = node.typeArguments[0]!;

        // First check if we have a registered Type for this node
        // (from schema-injection when synthetic TypeNodes were created)
        let type: ts.Type;
        if (typeRegistry && typeRegistry.has(node)) {
          type = typeRegistry.get(node)!;
        } else {
          // Fall back to getting Type from TypeNode
          type = checker.getTypeFromTypeNode(typeArg);
        }

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

        // If Type resolved to 'any' and we have a synthetic TypeNode, try analyzing its structure
        let schema: unknown;
        if (
          (type.flags & ts.TypeFlags.Any) &&
          typeArg.pos === -1 &&
          typeArg.end === -1
        ) {
          // This is a synthetic TypeNode that didn't resolve to a proper Type
          // Analyze the TypeNode structure, checking typeRegistry for property Types
          schema = analyzeTypeNodeStructure(typeArg, checker, context.factory, typeRegistry);
        } else {
          // Normal path: use Type-based schema generation
          schema = generateSchema!(type, checker, typeArg);
        }

        // Handle boolean schemas (true/false) - can't spread them
        const finalSchema = typeof schema === "boolean"
          ? schema
          : { ...(schema as Record<string, unknown>), ...optionsObj };
        const schemaAst = createSchemaAst(finalSchema, context.factory);

        const constAssertion = context.factory.createAsExpression(
          schemaAst,
          context.factory.createTypeReferenceNode(
            context.factory.createIdentifier("const"),
            undefined,
          ),
        );

        const jsonSchemaName = context.ctHelpers.getHelperQualified(
          "JSONSchema",
        );
        const satisfiesExpression = context.factory.createSatisfiesExpression(
          constAssertion,
          context.factory.createTypeReferenceNode(jsonSchemaName),
        );

        return satisfiesExpression;
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }
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

// Helper type extending CallExpression with
// truthy typeArguments.
interface ToSchemaNode extends ts.CallExpression {
  typeArguments: ts.NodeArray<ts.TypeNode>;
}
function isToSchemaNode(node: ts.Node): node is ToSchemaNode {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length !== 1) return false;

  // Raw identity expression `toSchema<T>()`
  if (
    ts.isIdentifier(expression) &&
    expression.text === "toSchema" &&
    typeArguments &&
    typeArguments.length === 1
  ) {
    return true;
  }
  // Raw property access expression `__ctHelpers.toSchema<T>()`
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText() === CT_HELPERS_IDENTIFIER &&
    expression.name.text === "toSchema"
  ) {
    return true;
  }
  return false;
}

/**
 * Analyze a synthetic TypeNode's structure to generate a schema when Type resolution fails.
 * Checks typeRegistry for property Types before recursing.
 */
function analyzeTypeNodeStructure(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: import("../core/mod.ts").TypeRegistry,
): unknown {
  // Handle TypeLiteral nodes (object types)
  if (ts.isTypeLiteralNode(typeNode)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const member of typeNode.members) {
      if (
        ts.isPropertySignature(member) &&
        member.name &&
        ts.isIdentifier(member.name) &&
        member.type
      ) {
        const propName = member.name.text;

        // First, check if this property's TypeNode is in the typeRegistry
        let propType: ts.Type | undefined;
        if (typeRegistry && typeRegistry.has(member.type)) {
          propType = typeRegistry.get(member.type);
        } else {
          // Try to get Type from the property's TypeNode
          const resolvedType = checker.getTypeFromTypeNode(member.type);
          if (!(resolvedType.flags & ts.TypeFlags.Any)) {
            propType = resolvedType;
          }
        }

        let propSchema: unknown;
        if (propType) {
          // We have a real Type - use normal schema generator
          if (!generateSchema) generateSchema = createSchemaTransformerV2();
          propSchema = generateSchema(propType, checker, member.type);
        } else {
          // No Type available - recurse on TypeNode structure
          propSchema = analyzeTypeNodeStructure(member.type, checker, factory, typeRegistry);
        }

        properties[propName] = propSchema;

        // Add to required if not optional
        if (!member.questionToken) {
          required.push(propName);
        }
      }
    }

    const schema: Record<string, unknown> = {
      type: "object",
      properties,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    return schema;
  }

  // Handle keyword types (string, number, boolean, etc.)
  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
    case ts.SyntaxKind.NullKeyword:
      return { type: "null" };
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
      // Accept any value
      return true;
  }

  // For other TypeNode kinds, try to resolve as Type
  const type = checker.getTypeFromTypeNode(typeNode);
  if (!(type.flags & ts.TypeFlags.Any)) {
    // Successfully resolved - use normal schema generator
    if (!generateSchema) generateSchema = createSchemaTransformerV2();
    return generateSchema(type, checker, typeNode);
  }

  // Fallback: accept any value
  return true;
}
