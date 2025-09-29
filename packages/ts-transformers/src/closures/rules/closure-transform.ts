import ts from "typescript";
import type { ClosureRule } from "../types.ts";
import type { TransformationContext } from "../../core/context.ts";
import { containsOpaqueRef } from "../../opaque-ref/types.ts";

/**
 * Detects captured variables in a function using TypeScript's symbol table.
 * Returns all captured expressions (both reactive and non-reactive).
 */
function collectCaptures(
  func: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): Set<ts.Expression> {
  const captures = new Set<ts.Expression>();

  function isNodeWithin(node: ts.Node, container: ts.Node): boolean {
    let current = node;
    while (current) {
      if (current === container) return true;
      current = current.parent;
    }
    return false;
  }

  function visit(node: ts.Node) {
    // For property access like state.discount, capture the whole expression
    if (ts.isPropertyAccessExpression(node)) {
      // Get the root object (e.g., 'state' in 'state.discount')
      let root = node.expression;
      while (ts.isPropertyAccessExpression(root)) {
        root = root.expression;
      }

      if (ts.isIdentifier(root)) {
        const symbol = checker.getSymbolAtLocation(root);
        if (!symbol) return;

        const declarations = symbol.getDeclarations();
        if (!declarations || declarations.length === 0) return;

        // Check if declared outside the function
        const isDeclaredOutside = declarations.some(
          (decl) => !isNodeWithin(decl, func),
        );

        if (isDeclaredOutside) {
          // Capture the whole property access expression
          captures.add(node);
          // Don't visit children of this property access
          return;
        }
      }
    }

    // For plain identifiers
    if (ts.isIdentifier(node)) {
      // Skip if this is part of a property access (handled above)
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        return;
      }

      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      if (!declarations || declarations.length === 0) return;

      // Check if declared outside the function
      const isDeclaredOutside = declarations.some(
        (decl) => !isNodeWithin(decl, func),
      );

      if (isDeclaredOutside) {
        captures.add(node);
      }
    }

    ts.forEachChild(node, visit);
  }

  if (func.body) {
    visit(func.body);
  }

  return captures;
}

/**
 * Checks if this is a map call on an OpaqueRef array.
 */
function isOpaqueRefMapCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  // Check if this is a property access expression with name "map"
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "map") return false;

  // Check if the object being mapped has OpaqueRef type
  const objectType = checker.getTypeAtLocation(node.expression.expression);
  return containsOpaqueRef(node.expression.expression, checker);
}

/**
 * Transform a map callback that captures variables.
 */
function transformMapCallback(
  mapCall: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  captures: Map<string, ts.Identifier[]>,
  context: TransformationContext,
  transformation: ts.TransformationContext,
): ts.CallExpression {
  const factory = transformation.factory;
  const imports = context.imports;

  // Build the params object from captures
  const paramProperties: ts.PropertyAssignment[] = [];
  const capturedVarNames = new Set<string>();

  for (const [varName, identifiers] of captures) {
    if (identifiers.length > 0) {
      capturedVarNames.add(varName);
      // Use the first identifier's location for the param value
      // Take the first identifier as the value expression
      const firstIdentifier = identifiers[0];
      if (firstIdentifier) {
        paramProperties.push(
          factory.createPropertyAssignment(
            factory.createIdentifier(varName),
            firstIdentifier,
          ),
        );
      }
    }
  }

  // If no captures, return the original call
  if (paramProperties.length === 0) {
    return mapCall;
  }

  // Import recipe
  imports.request({
    name: "recipe",
    // module defaults to "commontools"
  });

  // Transform the callback parameters
  // Original: (item, index?) => ...
  // New: ({elem, index?, params: {captured1, captured2}}) => ...

  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const indexParam = originalParams[1]; // May be undefined

  // Create the destructured parameter
  const properties: ts.BindingElement[] = [
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier("elem"),
      undefined,
    ),
  ];

  if (indexParam) {
    properties.push(
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier("index"),
        undefined,
      ),
    );
  }

  // Add params destructuring
  const paramsPattern = factory.createObjectBindingPattern(
    Array.from(capturedVarNames).map((name) =>
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(name),
        undefined,
      )
    ),
  );

  properties.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier("params"),
      paramsPattern,
      undefined,
    ),
  );

  const destructuredParam = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(properties),
    undefined,
    undefined,
    undefined,
  );

  // Transform the callback body to use elem instead of the original param name
  const elemName = elemParam?.name;
  let transformedBody = callback.body;

  // Replace references to the original param with elem
  if (elemName && ts.isIdentifier(elemName) && elemName.text !== "elem") {
    const visitor: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && node.text === elemName.text) {
        return factory.createIdentifier("elem");
      }
      return ts.visitEachChild(node, visitor, transformation);
    };
    transformedBody = ts.visitNode(
      transformedBody,
      visitor,
    ) as typeof transformedBody;
  }

  // Replace captured variable references with params.varName
  for (const varName of capturedVarNames) {
    const visitor: ts.Visitor = (node) => {
      if (ts.isIdentifier(node) && node.text === varName) {
        // Check if this identifier is actually a capture (not a local binding)
        const symbol = context.checker.getSymbolAtLocation(node);
        if (symbol) {
          const declarations = symbol.getDeclarations();
          if (declarations && declarations.length > 0) {
            const isDeclaredOutside = declarations.some(
              (decl) => !isNodeWithin(decl, callback),
            );
            if (isDeclaredOutside) {
              return factory.createIdentifier(varName);
            }
          }
        }
      }
      return ts.visitEachChild(node, visitor, transformation);
    };
    transformedBody = ts.visitNode(
      transformedBody,
      visitor,
    ) as typeof transformedBody;
  }

  // Create the new callback
  const newCallback = factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    [destructuredParam],
    callback.type,
    ts.isArrowFunction(callback)
      ? callback.equalsGreaterThanToken
      : factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    transformedBody,
  );

  // Wrap in recipe()
  const recipeCall = factory.createCallExpression(
    factory.createIdentifier("recipe"),
    undefined,
    [newCallback],
  );

  // Create the object with op and params
  const mapObject = factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      factory.createIdentifier("op"),
      recipeCall,
    ),
    factory.createPropertyAssignment(
      factory.createIdentifier("params"),
      factory.createObjectLiteralExpression(paramProperties),
    ),
  ]);

  // Return the transformed map call
  return factory.createCallExpression(
    mapCall.expression,
    mapCall.typeArguments,
    [mapObject],
  );
}

function isNodeWithin(node: ts.Node, container: ts.Node): boolean {
  let current = node;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

export function createClosureTransformRule(): ClosureRule {
  return {
    name: "closure-transform",
    transform(
      sourceFile: ts.SourceFile,
      context: TransformationContext,
      transformation: ts.TransformationContext,
    ): ts.SourceFile {
      const checker = context.checker;
      const factory = transformation.factory;

      function visit(node: ts.Node): ts.Node {
        // Check for map calls with callbacks
        if (ts.isCallExpression(node) && isOpaqueRefMapCall(node, checker)) {
          const callback = node.arguments[0];

          // Check if the callback is an arrow function or function expression
          if (
            callback &&
            (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ) {
            // Collect captures
            const captures = collectCaptures(callback, checker);

            if (captures.size > 0) {
              // Group captures by variable name
              const capturesByName = new Map<string, ts.Identifier[]>();
              for (const identifier of captures) {
                const name = identifier.text;
                if (!capturesByName.has(name)) {
                  capturesByName.set(name, []);
                }
                capturesByName.get(name)!.push(identifier);
              }

              // Transform the map call
              return transformMapCallback(
                node,
                callback,
                capturesByName,
                context,
                transformation,
              );
            }
          }
        }

        // Continue visiting children
        return ts.visitEachChild(node, visit, transformation);
      }

      return ts.visitNode(sourceFile, visit) as ts.SourceFile;
    },
  };
}
