import ts from "typescript";
import { getCommonToolsModuleAlias } from "./imports.ts";
import { collectOpaqueRefs, containsOpaqueRef, isOpaqueRefType, isSimpleOpaqueRefAccess } from "./types.ts";

/**
 * Replaces an OpaqueRef expression with a parameter in a larger expression.
 */
export function replaceOpaqueRefWithParam(
  expression: ts.Expression,
  opaqueRef: ts.Expression,
  paramName: string,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    // If this is the OpaqueRef we're replacing, return the parameter
    if (node === opaqueRef) {
      return factory.createIdentifier(paramName);
    }
    
    return ts.visitEachChild(node, visit, context);
  };
  
  return visit(expression) as ts.Expression;
}

/**
 * Creates an ifElse call from a ternary expression.
 */
export function createIfElseCall(
  ternary: ts.ConditionalExpression,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
): ts.CallExpression {
  // For AMD output, TypeScript transforms imports into module parameters
  // e.g., import { ifElse } from "commontools" becomes a parameter commontools_1
  // We need to use the transformed module name pattern
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);

  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : factory.createIdentifier("ifElse");

  return factory.createCallExpression(
    ifElseIdentifier,
    undefined,
    [ternary.condition, ternary.whenTrue, ternary.whenFalse],
  );
}

/**
 * Transforms an expression containing OpaqueRef values.
 * Currently only handles binary expressions.
 */
export function transformExpressionWithOpaqueRef(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
): ts.Expression {
  // Only transform binary expressions (e.g., cell.value + 1, cell.value * 2)
  if (ts.isBinaryExpression(expression)) {
    // Get unique variable name
    const varName = "_v";
    
    // Get all OpaqueRef identifiers in the expression
    const opaqueRefs = collectOpaqueRefs(expression, checker);
    
    if (opaqueRefs.length === 0) {
      return expression;
    }

    // For now, support single OpaqueRef expressions
    // TODO: Handle multiple OpaqueRefs in one expression
    const opaqueRef = opaqueRefs[0];
    
    // Create the lambda body by replacing the OpaqueRef with the parameter
    const lambdaBody = replaceOpaqueRefWithParam(expression, opaqueRef, varName, factory, context);
    
    // Create arrow function: (_v) => expression
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(varName),
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    
    // Create derive call
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : factory.createIdentifier("derive");
    
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [opaqueRef, arrowFunction],
    );
  }
  
  return expression;
}

/**
 * Result of a transformation check.
 */
export interface TransformationResult {
  transformed: boolean;
  node: ts.Node;
  type: 'ternary' | 'jsx' | 'binary' | null;
  error?: string;
}

/**
 * Checks if a node should be transformed and what type of transformation.
 */
export function checkTransformation(
  node: ts.Node,
  checker: ts.TypeChecker,
): TransformationResult {
  // Check if it's a conditional expression
  if (ts.isConditionalExpression(node)) {
    const conditionType = checker.getTypeAtLocation(node.condition);
    
    // Check if the type is OpaqueRef<T>
    if (isOpaqueRefType(conditionType, checker)) {
      return {
        transformed: true,
        node,
        type: 'ternary',
      };
    }
  }

  // Check if it's a JSX expression that contains OpaqueRef values
  if (ts.isJsxExpression(node) && node.expression) {
    // Skip simple OpaqueRef accesses
    if (!isSimpleOpaqueRefAccess(node.expression, checker) && 
        containsOpaqueRef(node.expression, checker)) {
      return {
        transformed: true,
        node,
        type: 'jsx',
      };
    }
  }

  // Check if it's a binary expression with OpaqueRef values
  if (ts.isBinaryExpression(node) && containsOpaqueRef(node, checker)) {
    return {
      transformed: true,
      node,
      type: 'binary',
    };
  }

  return {
    transformed: false,
    node,
    type: null,
  };
}