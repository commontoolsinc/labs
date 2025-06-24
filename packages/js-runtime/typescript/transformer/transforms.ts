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
 * Replaces multiple OpaqueRef expressions with their corresponding parameters.
 */
export function replaceOpaqueRefsWithParams(
  expression: ts.Expression,
  refToParamName: Map<ts.Expression, string>,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    // Check if this node is one of the OpaqueRefs we're replacing
    for (const [ref, paramName] of refToParamName) {
      if (node === ref) {
        return factory.createIdentifier(paramName);
      }
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
  // Check if we're using the old "commontools" import which needs AMD-style module reference
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);
  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : factory.createIdentifier("ifElse");

  // Strip parentheses from whenTrue and whenFalse if they are ParenthesizedExpressions
  let whenTrue = ternary.whenTrue;
  let whenFalse = ternary.whenFalse;
  
  while (ts.isParenthesizedExpression(whenTrue)) {
    whenTrue = whenTrue.expression;
  }
  
  while (ts.isParenthesizedExpression(whenFalse)) {
    whenFalse = whenFalse.expression;
  }

  return factory.createCallExpression(
    ifElseIdentifier,
    undefined,
    [ternary.condition, whenTrue, whenFalse],
  );
}

/**
 * Transforms an expression containing OpaqueRef values.
 * Handles binary expressions and call expressions.
 */
export function transformExpressionWithOpaqueRef(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
): ts.Expression {
  // Handle call expressions (e.g., someFunction(a + 1, "prefix"))
  if (ts.isCallExpression(expression)) {
    // Get all OpaqueRef identifiers in the entire call expression
    const opaqueRefs = collectOpaqueRefs(expression, checker);
    
    if (opaqueRefs.length === 0) {
      return expression;
    }

    // Deduplicate OpaqueRefs (same ref might appear multiple times)
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    
    opaqueRefs.forEach(ref => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        // Map this ref to the same parameter name as the first occurrence
        const firstRef = uniqueRefs.get(refText)!;
        refToParamName.set(ref, refToParamName.get(firstRef)!);
      }
    });
    
    const uniqueRefArray = Array.from(uniqueRefs.values());
    
    // Replace all occurrences of refs with their parameters in the entire call
    const lambdaBody = replaceOpaqueRefsWithParams(expression, refToParamName, factory, context);
    
    // If there's only one unique ref, use the simple form: derive(ref, _v => ...)
    if (uniqueRefArray.length === 1) {
      const ref = uniqueRefArray[0];
      const paramName = refToParamName.get(ref)!;
      
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      
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
        [ref, arrowFunction],
      );
    }
    
    // Multiple unique refs: use object form derive({a, b}, ({a: _v1, b: _v2}) => ...)
    const paramNames = uniqueRefArray.map(ref => refToParamName.get(ref)!);
    
    // Create object literal for refs: {a, b, c}
    const refProperties = uniqueRefArray.map((ref) => {
      // For simple identifiers, use shorthand: {a, b}
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(
          ref,
          undefined
        );
      } else if (ts.isPropertyAccessExpression(ref)) {
        // For property access, use the full property path as the key
        // e.g., state.count becomes "state.count": state.count
        const propName = ref.getText().replace(/\./g, '_'); // Replace dots with underscores for valid identifiers
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref
        );
      } else {
        // Fallback to generic name
        const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref
        );
      }
    });
    
    const refObject = factory.createObjectLiteralExpression(refProperties, false);
    
    // Create object pattern for parameters: {a: _v1, b: _v2}
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = paramNames[index];
      
      // Determine the property name to use in the binding pattern
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        // Use the same naming scheme as above
        propName = ref.getText().replace(/\./g, '_');
      } else {
        propName = `ref${index + 1}`;
      }
      
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined
      );
    });
    
    const paramPattern = factory.createObjectBindingPattern(paramProperties);
    
    // Create arrow function: ({_v1, _v2}) => expression
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramPattern,
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
      [refObject, arrowFunction],
    );
  }
  
  // Handle binary expressions (e.g., cell.value + 1, cell.value * 2)
  if (ts.isBinaryExpression(expression)) {
    // Get unique variable name
    const varName = "_v";
    
    // Get all OpaqueRef identifiers in the expression
    const opaqueRefs = collectOpaqueRefs(expression, checker);
    
    if (opaqueRefs.length === 0) {
      return expression;
    }

    // Deduplicate OpaqueRefs (same ref might appear multiple times)
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    
    opaqueRefs.forEach(ref => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        // Map this ref to the same parameter name as the first occurrence
        const firstRef = uniqueRefs.get(refText)!;
        refToParamName.set(ref, refToParamName.get(firstRef)!);
      }
    });
    
    const uniqueRefArray = Array.from(uniqueRefs.values());
    
    // If there's only one unique ref, use the simple form: derive(ref, _v => ...)
    if (uniqueRefArray.length === 1) {
      const ref = uniqueRefArray[0];
      const paramName = refToParamName.get(ref)!;
      
      // Replace all occurrences of this ref with the parameter
      const lambdaBody = replaceOpaqueRefsWithParams(expression, refToParamName, factory, context);
      
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      
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
        [ref, arrowFunction],
      );
    }
    
    // Multiple unique refs: use object form derive({a, b}, ({a: _v1, b: _v2}) => ...)
    const paramNames = uniqueRefArray.map(ref => refToParamName.get(ref)!);
    
    // Create object literal for refs: {a, b, c}
    const refProperties = uniqueRefArray.map((ref) => {
      // For simple identifiers, use shorthand: {a, b}
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(
          ref,
          undefined
        );
      } else if (ts.isPropertyAccessExpression(ref)) {
        // For property access, use the full property path as the key
        // e.g., state.count becomes "state.count": state.count
        const propName = ref.getText().replace(/\./g, '_'); // Replace dots with underscores for valid identifiers
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref
        );
      } else {
        // Fallback to generic name
        const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref
        );
      }
    });
    
    const refObject = factory.createObjectLiteralExpression(refProperties, false);
    
    // Create object pattern for parameters: {a: _v1, b: _v2}
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = paramNames[index];
      
      // Determine the property name to use in the binding pattern
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        // Use the same naming scheme as above
        propName = ref.getText().replace(/\./g, '_');
      } else {
        propName = `ref${index + 1}`;
      }
      
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined
      );
    });
    
    const paramPattern = factory.createObjectBindingPattern(paramProperties);
    
    // Replace all refs in the expression with their corresponding parameters
    const lambdaBody = replaceOpaqueRefsWithParams(expression, refToParamName, factory, context);
    
    // Create arrow function: ({_v1, _v2}) => expression
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramPattern,
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
      [refObject, arrowFunction],
    );
  }
  
  return expression;
}

/**
 * Transforms OpaqueRef values to add .get() calls.
 * This is used for function calls, array indexing, and template literals.
 */
export function addGetCallsToOpaqueRefs(
  node: ts.Node,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
): ts.Node {
  const visit = (n: ts.Node): ts.Node => {
    // Check if this node is an OpaqueRef that needs .get()
    if (ts.isExpression(n)) {
      // Skip if this is already a .get() call
      if (ts.isCallExpression(n) && 
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === "get" &&
          n.arguments.length === 0) {
        // This is already a .get() call, just transform its object
        const transformedObject = visit(n.expression.expression) as ts.Expression;
        return factory.updateCallExpression(
          n,
          factory.updatePropertyAccessExpression(
            n.expression,
            transformedObject,
            n.expression.name
          ),
          n.typeArguments,
          n.arguments
        );
      }
      
      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        // Create a .get() call
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            n,
            factory.createIdentifier("get")
          ),
          undefined,
          []
        );
      }
    }
    
    return ts.visitEachChild(n, visit, context);
  };
  
  return visit(node);
}

/**
 * Result of a transformation check.
 */
export interface TransformationResult {
  transformed: boolean;
  node: ts.Node;
  type: 'ternary' | 'jsx' | 'binary' | 'call' | 'element-access' | 'template' | null;
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


  // Check if it's an element access expression (array indexing) with OpaqueRef
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    if (containsOpaqueRef(node.argumentExpression, checker)) {
      return {
        transformed: true,
        node,
        type: 'element-access',
      };
    }
  }

  // Check if it's a template expression with OpaqueRef
  if (ts.isTemplateExpression(node)) {
    const hasOpaqueRefSpans = node.templateSpans.some(span => 
      containsOpaqueRef(span.expression, checker)
    );
    if (hasOpaqueRefSpans) {
      return {
        transformed: true,
        node,
        type: 'template',
      };
    }
  }

  return {
    transformed: false,
    node,
    type: null,
  };
}