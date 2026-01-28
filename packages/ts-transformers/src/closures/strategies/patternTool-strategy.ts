import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { detectCallKind, isFunctionLikeExpression } from "../../ast/mod.ts";
import { groupCapturesByRoot } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import { createPropertyName } from "../../utils/identifiers.ts";
import { isOpaqueRefType } from "../../transformers/opaque-ref/opaque-ref.ts";

/**
 * PatternToolStrategy transforms patternTool() calls to capture closed-over variables.
 *
 * This strategy allows standalone functions passed to patternTool() to close over
 * reactive values, which are then automatically added to the extraParams object.
 *
 * Input:
 * ```ts
 * const content = cell("Hello");
 * const grepTool = patternTool(
 *   ({ query }: { query: string }) => {
 *     return derive({ query }, ({ query }) => {
 *       return content.split("\n").filter((c) => c.includes(query));
 *     });
 *   }
 * );
 * ```
 *
 * Output:
 * ```ts
 * const content = cell("Hello");
 * const grepTool = patternTool(
 *   ({ query, content }: { query: string; content: string }) => {
 *     return derive({ query }, ({ query }) => {
 *       return content.split("\n").filter((c) => c.includes(query));
 *     });
 *   },
 *   { content }
 * );
 * ```
 *
 * The strategy:
 * 1. Detects patternTool(fn) or patternTool(fn, extraParams) calls
 * 2. Collects captures from the function body
 * 3. Merges captures into the extraParams object
 * 4. Updates the function's parameter type to include captured variables
 */
export class PatternToolStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callKind = detectCallKind(node, context.checker);
    return callKind?.kind === "pattern-tool";
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformPatternToolCall(node, context, visitor);
  }
}

/**
 * Transform a patternTool call to include captured variables in extraParams.
 */
function transformPatternToolCall(
  patternToolCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker } = context;

  // Get the callback function (first argument)
  const callback = patternToolCall.arguments[0];
  if (!callback || !isFunctionLikeExpression(callback)) {
    return undefined;
  }

  // Collect module-scoped reactive captures from the callback
  // Unlike CaptureCollector which skips module-scoped variables,
  // patternTool needs to capture reactive (Cell-like) module-scoped variables
  const captureExpressions = collectModuleScopedReactiveCaptures(
    callback,
    context,
  );
  const captureTree = groupCapturesByRoot(captureExpressions);

  // If no captures, no transformation needed
  if (captureExpressions.size === 0) {
    return undefined;
  }

  // Transform the callback body (recursively handle nested closures)
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Get existing extraParams (second argument) if present
  const existingExtraParams = patternToolCall.arguments[1];

  // Build the merged extraParams object
  const captureProperties: ts.ObjectLiteralElementLike[] = [];

  // Add captures
  for (const [captureName, node] of captureTree) {
    captureProperties.push(
      factory.createPropertyAssignment(
        createPropertyName(captureName, factory),
        buildHierarchicalParamsValue(node, captureName, factory),
      ),
    );
  }

  // Merge with existing extraParams if present
  let mergedExtraParams: ts.Expression;
  if (
    existingExtraParams && ts.isObjectLiteralExpression(existingExtraParams)
  ) {
    // Combine existing properties with captures
    // Captures come first, existing properties override if there are duplicates
    const existingProperties = existingExtraParams.properties.filter((prop) => {
      // Skip properties that are being captured (captures win)
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        return !captureTree.has(prop.name.text);
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        return !captureTree.has(prop.name.text);
      }
      return true;
    });

    mergedExtraParams = factory.createObjectLiteralExpression(
      [...captureProperties, ...existingProperties],
      captureProperties.length + existingProperties.length > 1,
    );
  } else if (existingExtraParams) {
    // Existing extraParams is a reference or complex expression
    // Use spread to merge: { ...captures, ...existingExtraParams }
    mergedExtraParams = factory.createObjectLiteralExpression(
      [
        ...captureProperties,
        factory.createSpreadAssignment(existingExtraParams),
      ],
      true,
    );
  } else {
    // No existing extraParams, just use captures
    mergedExtraParams = factory.createObjectLiteralExpression(
      captureProperties,
      captureProperties.length > 1,
    );
  }

  // Build the new callback with updated parameter type
  // We need to add the captured variables to the parameter's type
  const newCallback = buildCallbackWithCaptures(
    callback,
    transformedBody,
    captureTree,
    context,
  );

  // Build the new patternTool call with the transformed callback and merged extraParams
  const newArgs: ts.Expression[] = [newCallback, mergedExtraParams];

  return factory.createCallExpression(
    patternToolCall.expression,
    patternToolCall.typeArguments,
    newArgs,
  );
}

/**
 * Build a new callback function with captured variables added to its parameter type.
 *
 * Original: ({ query }: { query: string }) => { ... }
 * With captures: ({ query, content }: { query: string; content: string }) => { ... }
 */
function buildCallbackWithCaptures(
  originalCallback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, unknown>,
  context: TransformationContext,
): ts.ArrowFunction | ts.FunctionExpression {
  const { factory, checker } = context;

  // Get the original parameter (patternTool callbacks take a single parameter)
  const originalParam = originalCallback.parameters[0];

  // Build new parameter with captures added
  let newParam: ts.ParameterDeclaration;

  if (originalParam) {
    // Get the existing parameter binding pattern
    const existingBinding = originalParam.name;

    if (ts.isObjectBindingPattern(existingBinding)) {
      // Add capture bindings to the existing object pattern
      const newBindingElements = [...existingBinding.elements];

      for (const captureName of captureTree.keys()) {
        // Check if this capture is already in the binding
        const alreadyExists = existingBinding.elements.some((element) => {
          if (ts.isIdentifier(element.name)) {
            return element.name.text === captureName;
          }
          return false;
        });

        if (!alreadyExists) {
          newBindingElements.push(
            factory.createBindingElement(
              undefined,
              undefined,
              factory.createIdentifier(captureName),
              undefined,
            ),
          );
        }
      }

      const newBindingPattern = factory.createObjectBindingPattern(
        newBindingElements,
      );

      // Update the type annotation if present
      let newTypeNode = originalParam.type;
      if (newTypeNode && ts.isTypeLiteralNode(newTypeNode)) {
        newTypeNode = addCapturesToTypeLiteral(
          newTypeNode,
          captureTree,
          context,
        );
      }

      newParam = factory.createParameterDeclaration(
        originalParam.modifiers,
        originalParam.dotDotDotToken,
        newBindingPattern,
        originalParam.questionToken,
        newTypeNode,
        originalParam.initializer,
      );
    } else {
      // Parameter is a simple identifier or other binding, keep as-is
      newParam = originalParam;
    }
  } else {
    // No original parameter, create one with just captures
    const bindingElements = Array.from(captureTree.keys()).map((captureName) =>
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(captureName),
        undefined,
      )
    );

    const bindingPattern = factory.createObjectBindingPattern(bindingElements);

    // Build type literal for captures
    const typeElements = Array.from(captureTree.keys()).map((captureName) => {
      return factory.createPropertySignature(
        undefined,
        factory.createIdentifier(captureName),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
    });

    newParam = factory.createParameterDeclaration(
      undefined,
      undefined,
      bindingPattern,
      undefined,
      factory.createTypeLiteralNode(typeElements),
      undefined,
    );
  }

  // Create the new callback
  if (ts.isArrowFunction(originalCallback)) {
    return factory.createArrowFunction(
      originalCallback.modifiers,
      originalCallback.typeParameters,
      [newParam],
      originalCallback.type,
      originalCallback.equalsGreaterThanToken,
      transformedBody,
    );
  } else {
    return factory.createFunctionExpression(
      originalCallback.modifiers,
      originalCallback.asteriskToken,
      originalCallback.name,
      originalCallback.typeParameters,
      [newParam],
      originalCallback.type,
      ts.isBlock(transformedBody)
        ? transformedBody
        : factory.createBlock([factory.createReturnStatement(transformedBody)]),
    );
  }
}

/**
 * Add captured variable types to a type literal node.
 */
function addCapturesToTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  captureTree: Map<string, unknown>,
  context: TransformationContext,
): ts.TypeLiteralNode {
  const { factory, checker } = context;

  // Get existing members
  const existingMembers = [...typeLiteral.members];

  // Add type for each capture
  for (const [captureName] of captureTree) {
    // Check if this property already exists
    const alreadyExists = existingMembers.some((member) => {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
        return member.name.text === captureName;
      }
      return false;
    });

    if (!alreadyExists) {
      // Add a property signature for the capture
      // We use 'unknown' as a placeholder type since we don't have precise type info
      existingMembers.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(captureName),
          undefined,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
      );
    }
  }

  return factory.createTypeLiteralNode(existingMembers);
}

/**
 * Collect module-scoped reactive (Cell-like) captures from a function.
 *
 * Unlike the regular CaptureCollector which skips module-scoped declarations,
 * patternTool needs to capture reactive values declared at module scope so
 * they can be passed as extraParams.
 */
function collectModuleScopedReactiveCaptures(
  func: ts.FunctionLikeDeclaration,
  context: TransformationContext,
): Set<ts.Expression> {
  const { checker } = context;
  const captures = new Set<ts.Expression>();

  // Get the function's parameters to exclude from captures
  const funcParamNames = new Set<string>();
  for (const param of func.parameters) {
    extractBindingNames(param.name, funcParamNames);
  }

  const visit = (node: ts.Node) => {
    // Skip nested function declarations - they have their own scope
    if (
      node !== func &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node))
    ) {
      // Still visit nested function to capture module-scoped refs used there
      ts.forEachChild(node, visit);
      return;
    }

    // Check identifiers for module-scoped reactive captures
    if (ts.isIdentifier(node)) {
      // Skip if this is part of a property access name (the property, not the object)
      if (
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node
      ) {
        return;
      }

      // Skip if this is a function parameter
      if (funcParamNames.has(node.text)) {
        return;
      }

      // Skip property names in object literals
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) {
        return;
      }

      // Skip shorthand property assignments (we'll check their value separately)
      if (ts.isShorthandPropertyAssignment(node.parent)) {
        // Check if this shorthand is referencing a captured value
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(
          node.parent,
        );
        if (valueSymbol) {
          const decls = valueSymbol.getDeclarations();
          if (decls && decls.length > 0) {
            const isModuleScoped = decls.some((d) =>
              isModuleScopedDeclaration(d)
            );
            if (isModuleScoped) {
              const type = checker.getTypeAtLocation(node);
              if (isCellLikeType(type, checker)) {
                captures.add(node);
              }
            }
          }
        }
        return;
      }

      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      if (!declarations || declarations.length === 0) return;

      // Skip imports
      const isImport = declarations.some(
        (decl) =>
          ts.isImportSpecifier(decl) ||
          ts.isImportClause(decl) ||
          ts.isNamespaceImport(decl),
      );
      if (isImport) return;

      // Check if it's module-scoped
      const isModuleScoped = declarations.some((decl) =>
        isModuleScopedDeclaration(decl)
      );
      if (!isModuleScoped) return;

      // Check if it's a reactive (Cell-like) type
      const type = checker.getTypeAtLocation(node);
      if (isCellLikeType(type, checker)) {
        captures.add(node);
      }
    }

    ts.forEachChild(node, visit);
  };

  if (func.body) {
    visit(func.body);
  }

  return captures;
}

/**
 * Extract all binding names from a binding pattern recursively.
 */
function extractBindingNames(
  binding: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(binding)) {
    names.add(binding.text);
    return;
  }

  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      extractBindingNames(element.name, names);
    }
  } else if (ts.isArrayBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (!ts.isOmittedExpression(element)) {
        extractBindingNames(element.name, names);
      }
    }
  }
}

/**
 * Check if a declaration is at module scope (top level of a source file).
 */
function isModuleScopedDeclaration(decl: ts.Declaration): boolean {
  // Walk up to find if this is at source file level
  let current: ts.Node = decl;
  while (current.parent) {
    // Check if the immediate parent is a variable statement at source file level
    if (ts.isVariableDeclaration(current)) {
      const varDeclList = current.parent;
      if (ts.isVariableDeclarationList(varDeclList)) {
        const varStatement = varDeclList.parent;
        if (
          ts.isVariableStatement(varStatement) &&
          ts.isSourceFile(varStatement.parent)
        ) {
          return true;
        }
      }
    }

    // Check for const/let/var at source file level
    if (
      ts.isVariableStatement(current) &&
      ts.isSourceFile(current.parent)
    ) {
      return true;
    }

    // Check for function declarations at source file level
    if (
      ts.isFunctionDeclaration(current) &&
      ts.isSourceFile(current.parent)
    ) {
      return true;
    }

    current = current.parent;
  }
  return false;
}

/**
 * Check if a type is a Cell-like type (Cell, OpaqueRef, etc.)
 * that represents reactive state.
 */
function isCellLikeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Check if it's an OpaqueRef type
  if (isOpaqueRefType(type, checker)) {
    return true;
  }

  // Check the type name for Cell-like types
  const typeStr = checker.typeToString(type);
  const cellLikePatterns = [
    "Cell<",
    "OpaqueCell<",
    "Writable<",
    "Stream<",
  ];

  return cellLikePatterns.some((pattern) => typeStr.includes(pattern));
}
