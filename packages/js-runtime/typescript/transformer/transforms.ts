import ts from "typescript";
import { getCommonToolsModuleAlias } from "./imports.ts";
import {
  collectOpaqueRefs,
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./types.ts";

/**
 * Get the name of the function being called in a CallExpression
 */
function getFunctionName(node: ts.CallExpression): string | undefined {
  const expr = node.expression;

  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }

  return undefined;
}

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

function getSimpleName(ref: ts.Expression): string | undefined {
  // Only use simple identifiers as parameter names
  // e.g., "state" or "count" but not "state.count" or complex expressions
  if (ts.isIdentifier(ref)) {
    return ref.text;
  }
  return undefined;
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
  // If this expression is part of a JSX event handler attribute, do not transform.
  // Event handlers like onClick expect functions, not derived values.
  if (
    ts.isJsxExpression(expression) && expression.parent &&
    ts.isJsxAttribute(expression.parent)
  ) {
    const attrName = expression.parent.name.getText();
    if (attrName.startsWith("on")) return expression;
  }

  // Handle property access expressions (e.g., person.name.length)
  if (ts.isPropertyAccessExpression(expression)) {
    // Get the OpaqueRef being accessed
    const opaqueRefs = collectOpaqueRefs(expression, checker);

    if (opaqueRefs.length === 0) {
      return expression;
    }

    // Handle multiple OpaqueRefs (e.g., state.items.filter(i => i.name.includes(state.filter)).length)
    if (opaqueRefs.length === 1) {
      // Special case for single OpaqueRef to produce cleaner output
      // Instead of: derive({state_count: state.count}, ({state_count: _v1}) => _v1 + 1)
      // We produce: derive(state.count, _v1 => _v1 + 1)
      // This is more readable, performant, and maintains backwards compatibility
      // Step 1: Extract the single OpaqueRef and assign a parameter name
      const ref = opaqueRefs[0];
      const paramName = getSimpleName(ref) ?? "_v1";

      // Step 2: Replace the OpaqueRef with the parameter in the expression
      // Example: state.count + 1 becomes _v1 + 1
      const lambdaBody = replaceOpaqueRefWithParam(
        expression,
        ref,
        paramName,
        factory,
        context,
      );

      // Step 3: Create the arrow function
      // Simple form: _v1 => expression
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName), // Single parameter: _v1
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody, // The transformed expression
      );

      // Step 4: Create the derive identifier
      // Handle both named imports (derive) and module imports (CommonTools.derive)
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : factory.createIdentifier("derive");

      // Step 5: Create the final derive() call
      // Simple form: derive(ref, _v1 => expression)
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction], // Note: ref directly, not an object
      );
    } else {
      // Multiple OpaqueRefs: use object form
      // Example: state.items.filter(i => i.name.includes(state.filter)).length
      // Will transform to:
      // derive(
      //   {state_items: state.items, state_filter: state.filter},
      //   ({state_items: _v1, state_filter: _v2}) => _v1.filter(i => i.name.includes(_v2)).length
      // )

      // Step 1: Deduplicate OpaqueRefs (same ref might appear multiple times)
      // For example, if state.count appears 3 times, we only want one parameter
      const uniqueRefs = new Map<string, ts.Expression>();
      const refToParamName = new Map<ts.Expression, string>();

      opaqueRefs.forEach((ref) => {
        const refText = ref.getText();
        if (!uniqueRefs.has(refText)) {
          // First occurrence of this ref - create a new parameter name
          const paramName = `_v${uniqueRefs.size + 1}`;
          uniqueRefs.set(refText, ref);
          refToParamName.set(ref, paramName);
        } else {
          // Duplicate ref - reuse the same parameter name
          const firstRef = uniqueRefs.get(refText)!;
          refToParamName.set(ref, refToParamName.get(firstRef)!);
        }
      });

      const uniqueRefArray = Array.from(uniqueRefs.values());

      // Step 2: Replace all OpaqueRef occurrences with their parameter names
      // This transforms the expression body to use _v1, _v2, etc.
      const lambdaBody = replaceOpaqueRefsWithParams(
        expression,
        refToParamName,
        factory,
        context,
      );

      // Step 3: Create object literal for refs - this will be the first argument to derive()
      // We need to create property names that are valid JavaScript identifiers
      const refProperties = uniqueRefArray.map((ref) => {
        if (ts.isIdentifier(ref)) {
          // Simple identifier like 'state' -> use shorthand {state}
          return factory.createShorthandPropertyAssignment(ref, undefined);
        } else if (ts.isPropertyAccessExpression(ref)) {
          // Property access like 'state.items' -> {state_items: state.items}
          // Replace dots with underscores to create valid identifier
          const propName = ref.getText().replace(/\./g, "_");
          return factory.createPropertyAssignment(
            factory.createIdentifier(propName),
            ref,
          );
        } else {
          // Fallback for other expression types
          const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
          return factory.createPropertyAssignment(
            factory.createIdentifier(propName),
            ref,
          );
        }
      });

      const refObject = factory.createObjectLiteralExpression(
        refProperties,
        false,
      );

      // Step 4: Create object pattern for parameters - this will destructure in the arrow function
      // Maps the property names to our parameter names (_v1, _v2, etc.)
      const paramProperties = uniqueRefArray.map((ref, index) => {
        const paramName = refToParamName.get(ref)!;
        let propName: string;
        if (ts.isIdentifier(ref)) {
          // Simple identifier: {state: _v1}
          propName = ref.text;
        } else if (ts.isPropertyAccessExpression(ref)) {
          // Property access: {state_items: _v1}
          propName = ref.getText().replace(/\./g, "_");
        } else {
          // Fallback: {ref1: _v1}
          propName = `ref${index + 1}`;
        }

        // Creates the binding: propName -> paramName
        // e.g., state_items: _v1
        return factory.createBindingElement(
          undefined,
          factory.createIdentifier(propName),
          factory.createIdentifier(paramName),
          undefined,
        );
      });

      const paramObjectPattern = factory.createObjectBindingPattern(
        paramProperties,
      );

      // Step 5: Create the arrow function with object destructuring
      // ({state_items: _v1, state_filter: _v2}) => expression
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          paramObjectPattern, // The destructuring pattern we created
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody, // The expression with refs replaced by _v1, _v2, etc.
      );

      // Step 6: Create the derive() call
      // Handle both named imports (derive) and module imports (CommonTools.derive)
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : factory.createIdentifier("derive");

      // Final result: derive({refs...}, ({destructured...}) => transformedExpression)
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [refObject, arrowFunction], // Note: refObject first, not a single ref
      );
    }
  }

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

    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
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
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );

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
    const paramNames = uniqueRefArray.map((ref) => refToParamName.get(ref)!);

    // Create object literal for refs: {a, b, c}
    const refProperties = uniqueRefArray.map((ref) => {
      // For simple identifiers, use shorthand: {a, b}
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(
          ref,
          undefined,
        );
      } else if (ts.isPropertyAccessExpression(ref)) {
        // For property access, use the full property path as the key
        // e.g., state.count becomes "state.count": state.count
        const propName = ref.getText().replace(/\./g, "_"); // Replace dots with underscores for valid identifiers
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      } else {
        // Fallback to generic name
        const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
    });

    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );

    // Create object pattern for parameters: {a: _v1, b: _v2}
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = paramNames[index];

      // Determine the property name to use in the binding pattern
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        // Use the same naming scheme as above
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }

      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
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

  // Handle template expressions (e.g., `Hello ${firstName} ${lastName}`)
  if (ts.isTemplateExpression(expression)) {
    // Get all OpaqueRef identifiers in the template expression
    const opaqueRefs = collectOpaqueRefs(expression, checker);

    if (opaqueRefs.length === 0) {
      return expression;
    }

    // Deduplicate OpaqueRefs
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();

    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        // Map this ref to the same parameter name as the first occurrence
        const firstRef = uniqueRefs.get(refText)!;
        refToParamName.set(ref, refToParamName.get(firstRef)!);
      }
    });

    const uniqueRefArray = Array.from(uniqueRefs.values());

    // Replace all occurrences of refs with their parameters in the template
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );

    // Create derive call based on number of unique refs
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

    // Multiple unique refs: use object form
    const paramNames = uniqueRefArray.map((ref) => refToParamName.get(ref)!);

    // Create object literal for refs
    const refProperties = uniqueRefArray.map((ref) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      } else if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      } else {
        const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
    });

    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );

    // Create object pattern for parameters
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = paramNames[index];
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }

      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });

    const paramPattern = factory.createObjectBindingPattern(paramProperties);

    // Create arrow function
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
    // Get all OpaqueRef identifiers in the expression
    const opaqueRefs = collectOpaqueRefs(expression, checker);

    if (opaqueRefs.length === 0) {
      return expression;
    }

    // Deduplicate OpaqueRefs (same ref might appear multiple times)
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();

    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
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
      const lambdaBody = replaceOpaqueRefsWithParams(
        expression,
        refToParamName,
        factory,
        context,
      );

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
    const paramNames = uniqueRefArray.map((ref) => refToParamName.get(ref)!);

    // Create object literal for refs: {a, b, c}
    const refProperties = uniqueRefArray.map((ref) => {
      // For simple identifiers, use shorthand: {a, b}
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(
          ref,
          undefined,
        );
      } else if (ts.isPropertyAccessExpression(ref)) {
        // For property access, use the full property path as the key
        // e.g., state.count becomes "state.count": state.count
        const propName = ref.getText().replace(/\./g, "_"); // Replace dots with underscores for valid identifiers
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      } else {
        // Fallback to generic name
        const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
    });

    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );

    // Create object pattern for parameters: {a: _v1, b: _v2}
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = paramNames[index];

      // Determine the property name to use in the binding pattern
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        // Use the same naming scheme as above
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }

      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });

    const paramPattern = factory.createObjectBindingPattern(paramProperties);

    // Replace all refs in the expression with their corresponding parameters
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );

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
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "get" &&
        n.arguments.length === 0
      ) {
        // This is already a .get() call, just transform its object
        const transformedObject = visit(
          n.expression.expression,
        ) as ts.Expression;
        return factory.updateCallExpression(
          n,
          factory.updatePropertyAccessExpression(
            n.expression,
            transformedObject,
            n.expression.name,
          ),
          n.typeArguments,
          n.arguments,
        );
      }

      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        // Create a .get() call
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            n,
            factory.createIdentifier("get"),
          ),
          undefined,
          [],
        );
      }
    }

    return ts.visitEachChild(n, visit, context);
  };

  return visit(node);
}

// TODO(@ubik2): Align these types with the TransformationType in debug.ts
export type TransformationTypeString =
  | "ternary"
  | "jsx"
  | "binary"
  | "call"
  | "element-access"
  | "template";

/**
 * Result of a transformation check.
 */
export interface TransformationResult {
  transformed: boolean;
  node: ts.Node;
  type: TransformationTypeString | null;
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
        type: "ternary",
      };
    }
  }

  // Check if it's a JSX expression that contains OpaqueRef values
  if (ts.isJsxExpression(node) && node.expression) {
    // Check if this JSX expression is in an event handler attribute
    const parent = node.parent;
    if (parent && ts.isJsxAttribute(parent)) {
      const attrName = parent.name.getText();
      // Event handlers like onClick expect functions, not derived values
      if (attrName.startsWith("on")) {
        // Don't transform event handlers
        return {
          transformed: false,
          node,
          type: null,
        };
      }
    }

    // Check if the expression is a call to a builder function
    if (ts.isCallExpression(node.expression)) {
      const functionName = getFunctionName(node.expression);
      const builderFunctions = [
        "recipe",
        "lift",
        "handler",
        "derive",
        "compute",
        "render",
        "ifElse",
        "str",
      ];
      if (functionName && builderFunctions.includes(functionName)) {
        // Don't transform calls to builder functions
        return {
          transformed: false,
          node,
          type: null,
        };
      }

      // Also skip if this is a method call (e.g., array.map)
      if (ts.isPropertyAccessExpression(node.expression.expression)) {
        // This is a method call, it should be handled at the CallExpression level
        return {
          transformed: false,
          node,
          type: null,
        };
      }
    }

    // Skip simple OpaqueRef accesses
    if (
      !isSimpleOpaqueRefAccess(node.expression, checker) &&
      containsOpaqueRef(node.expression, checker)
    ) {
      return {
        transformed: true,
        node,
        type: "jsx",
      };
    }
  }

  // Note: Binary expressions, element access, and template expressions
  // are no longer transformed at the statement level.
  // They are only transformed when they appear inside JSX expressions,
  // which is handled by the JSX expression case above.

  return {
    transformed: false,
    node,
    type: null,
  };
}
