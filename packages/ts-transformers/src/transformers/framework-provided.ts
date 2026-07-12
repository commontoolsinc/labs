import ts from "typescript";

import {
  detectCallKind,
  findEnclosingPatternBuilderCallbackDescriptor,
  getPatternBuilderCallbackDescriptor,
  isPatternBuilderCall,
  updatePatternBuilderCallbackArgument,
} from "../ast/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  extractBindingNames,
  reserveIdentifier,
} from "../utils/identifiers.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  findFactoryInputFrameworkProvidedPaths,
  findFrameworkProvidedPaths,
  type FrameworkProvidedPath,
} from "../policy/framework-provided.ts";

type FunctionExpression = ts.ArrowFunction | ts.FunctionExpression;

/** Structurally forward protected aliases before symbolic call lowering. */
export class FrameworkProvidedForwardingTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context.tsContext);
      if (!ts.isCallExpression(visited)) return visited;
      const descriptor = getPatternBuilderCallbackDescriptor(
        visited,
        context.checker,
      );
      if (!descriptor) {
        validateScheduledFactoryCalls(visited, context);
        return visited;
      }
      const rewritten = rewritePatternCallback(descriptor.callback, context);
      if (rewritten.callback === descriptor.callback) return visited;
      const updatedArgument = updatePatternBuilderCallbackArgument(
        descriptor,
        rewritten.callback,
        context.factory,
      );
      return context.factory.updateCallExpression(
        visited,
        visited.expression,
        visited.typeArguments,
        [updatedArgument, ...visited.arguments.slice(1)],
      );
    };
    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

/** Attach trusted path metadata after schema and callback lowering. */
export class FrameworkProvidedTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context.tsContext);
      if (!ts.isCallExpression(visited)) return visited;

      const descriptor = getPatternBuilderCallbackDescriptor(
        visited,
        context.checker,
      );
      if (!descriptor) {
        return addNonPatternFactoryMetadata(visited, context);
      }

      const declared = frameworkPathsForParameter(
        descriptor.callback.parameters[0],
        context,
      );
      const paths = mergePaths(
        declared,
        frameworkPathsForCallback(descriptor.callback, context),
      );
      const call = visited;
      if (paths.length === 0) return call;
      const invalid = paths.find((path) => !isSupportedPath(path));
      if (invalid) {
        context.reportDiagnosticOnce({
          severity: "error",
          type: "framework-provided:non-static-path",
          message: `FrameworkProvided path '${
            invalid.join(".")
          }' cannot be forwarded; only non-empty object-property paths are supported.`,
          node: descriptor.callback,
        });
        return call;
      }

      const currentDescriptor = getPatternBuilderCallbackDescriptor(
        call,
        context.checker,
      );
      if (!currentDescriptor) return call;
      const carrier = context.cfHelpers.createHelperCall(
        "withFrameworkProvidedPaths",
        currentDescriptor.argument,
        undefined,
        [currentDescriptor.argument, pathsExpression(paths, context.factory)],
      );
      return context.factory.updateCallExpression(
        call,
        call.expression,
        call.typeArguments,
        [carrier, ...call.arguments.slice(1)],
      );
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function frameworkPathsForCallback(
  callback: FunctionExpression,
  context: TransformationContext,
): readonly FrameworkProvidedPath[] {
  const paths: FrameworkProvidedPath[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && !isInternalFrameworkHelper(node)) {
      paths.push(...frameworkPathsForFactoryExpression(
        node.expression,
        context,
        new Set(),
        new Set(),
      ));
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return mergePaths(paths);
}

function addNonPatternFactoryMetadata(
  call: ts.CallExpression,
  context: TransformationContext,
): ts.CallExpression {
  const kind = detectCallKind(call, context.checker);
  if (
    kind?.kind !== "builder" ||
    (kind.builderName !== "lift" && kind.builderName !== "handler")
  ) {
    return call;
  }
  const callbackIndex = call.arguments.findIndex((argument) =>
    !!resolveFunction(argument, context.checker)
  );
  if (callbackIndex < 0) return call;
  const callbackExpression = call.arguments[callbackIndex]!;
  const callback = resolveFunction(callbackExpression, context.checker);
  if (!callback) return call;
  const parameterIndex = kind.builderName === "handler" ? 1 : 0;
  const paths = frameworkPathsForParameter(
    callback.parameters[parameterIndex],
    context,
  );
  if (paths.length === 0) return call;
  const carrier = context.cfHelpers.createHelperCall(
    "withFrameworkProvidedPaths",
    callbackExpression,
    undefined,
    [callbackExpression, pathsExpression(paths, context.factory)],
  );
  const args = [...call.arguments];
  args[callbackIndex] = carrier;
  return context.factory.updateCallExpression(
    call,
    call.expression,
    call.typeArguments,
    args,
  );
}

function resolveFunction(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FunctionExpression | undefined {
  const target = unwrapExpression(expression);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return target;
  }
  if (!ts.isIdentifier(target)) return undefined;
  let symbol = checker.getSymbolAtLocation(ts.getOriginalNode(target));
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveFunction(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function rewritePatternCallback(
  callback: FunctionExpression,
  context: TransformationContext,
): { callback: FunctionExpression; paths: readonly FrameworkProvidedPath[] } {
  // Preserve ordinary callbacks byte-for-byte. Parameter rewriting is needed
  // only when this callback actually forwards a protected factory input; doing
  // it speculatively would perturb every destructured pattern in the repo.
  const protectedCallPaths = frameworkPathsForCallback(callback, context);
  if (protectedCallPaths.length === 0) {
    return { callback, paths: [] };
  }
  const publicType = patternPublicInputType(callback, context);
  let root = callback.parameters[0];
  let updated = callback;
  let bindingPrologue: ts.Statement | undefined;
  if (!root || !ts.isIdentifier(root.name)) {
    const usedNames = new Set<string>();
    for (const parameter of callback.parameters) {
      for (const name of extractBindingNames(parameter.name)) {
        usedNames.add(name);
      }
    }
    const collectNames = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) usedNames.add(node.text);
      ts.forEachChild(node, collectNames);
    };
    collectNames(callback.body);
    const identifier = reserveIdentifier(
      "__cf_framework_input",
      usedNames,
      context.factory,
    );
    const replacement = root
      ? context.factory.updateParameterDeclaration(
        root,
        root.modifiers,
        root.dotDotDotToken,
        identifier,
        root.questionToken,
        root.type,
        root.initializer,
      )
      : context.factory.createParameterDeclaration(
        undefined,
        undefined,
        identifier,
      );
    if (root && !ts.isIdentifier(root.name)) {
      bindingPrologue = context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList(
          [context.factory.createVariableDeclaration(
            root.name,
            undefined,
            undefined,
            identifier,
          )],
          ts.NodeFlags.Const,
        ),
      );
    }
    updated = updateFunctionParameters(
      callback,
      [replacement, ...callback.parameters.slice(root ? 1 : 0)],
      context.factory,
    );
    root = replacement;
  }

  const paths: FrameworkProvidedPath[] = [];
  const rewrite: ts.Visitor = (node) => {
    if (node !== updated.body && ts.isFunctionLike(node)) return node;
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, rewrite, context.tsContext);
    }
    if (isInternalFrameworkHelper(node)) return node;
    const protectedPaths = frameworkPathsForFactoryExpression(
      node.expression,
      context,
      new Set(),
      new Set(),
    );
    if (protectedPaths.length === 0) {
      return ts.visitEachChild(node, rewrite, context.tsContext);
    }
    const invalid = protectedPaths.find((path) => !isSupportedPath(path));
    if (invalid) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "framework-provided:non-static-path",
        message: `FrameworkProvided path '${
          invalid.join(".")
        }' cannot be forwarded; only non-empty object-property paths are supported.`,
        node,
      });
      return node;
    }

    const authored = node.arguments[0];
    const object = authored && asObjectLiteral(authored);
    if (!object) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message:
          "A factory with FrameworkProvided inputs requires a proven object-literal call so authored values cannot be laundered into system paths.",
        node,
      });
      return node;
    }
    const supplied = protectedPaths.find((path) =>
      objectLiteralSuppliesPath(object, path)
    );
    if (supplied) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message:
          `An authored factory input cannot supply FrameworkProvided path '${
            supplied.join(".")
          }'; the framework forwards it from wrapper argument 0.`,
        node: authored,
      });
      return node;
    }

    paths.push(...protectedPaths);
    const input = addForwardedPathsToObject(
      object,
      root!.name as ts.Identifier,
      protectedPaths,
      publicType,
      context,
    );
    return context.factory.updateCallExpression(
      node,
      node.expression,
      node.typeArguments,
      [input],
    );
  };

  let body = ts.visitNode(updated.body, rewrite) as ts.ConciseBody;
  if (bindingPrologue) {
    body = ts.isBlock(body)
      ? context.factory.updateBlock(body, [bindingPrologue, ...body.statements])
      : context.factory.createBlock([
        bindingPrologue,
        context.factory.createReturnStatement(body),
      ], true);
  }
  return {
    callback: updateFunctionBody(updated, body, context.factory),
    paths: mergePaths(paths),
  };
}

function validateScheduledFactoryCalls(
  call: ts.CallExpression,
  context: TransformationContext,
): void {
  const kind = detectCallKind(call, context.checker);
  if (
    kind?.kind !== "builder" ||
    (kind.builderName !== "lift" && kind.builderName !== "handler")
  ) return;
  const callback = call.arguments.map((argument) =>
    resolveFunction(argument, context.checker)
  ).find((candidate) => candidate !== undefined);
  if (!callback) return;
  let reported = false;
  const visit = (node: ts.Node): void => {
    if (reported || node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const paths = frameworkPathsForFactoryExpression(
        node.expression,
        context,
        new Set(),
        new Set(),
      );
      if (paths.length > 0) {
        const path = paths[0]!;
        context.reportDiagnosticOnce({
          severity: "error",
          type: "scheduled-callback:framework-provided-factory-call",
          message:
            `A materialized factory call inside ${kind.builderName} requires FrameworkProvided path '${
              path.join(".")
            }', but handler event/context and lift input are authored data, not a trusted system-input channel.`,
          node,
        });
        reported = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
}

function addForwardedPathsToObject(
  object: ts.ObjectLiteralExpression,
  root: ts.Identifier,
  paths: readonly FrameworkProvidedPath[],
  publicType: ts.Type | undefined,
  context: TransformationContext,
): ts.ObjectLiteralExpression {
  let result = object;
  for (const path of paths) {
    result = addForwardedPathToObject(
      result,
      root,
      path,
      path,
      publicType,
      context,
    );
  }
  return result;
}

function addForwardedPathToObject(
  object: ts.ObjectLiteralExpression,
  root: ts.Identifier,
  remaining: readonly string[],
  complete: readonly string[],
  publicType: ts.Type | undefined,
  context: TransformationContext,
): ts.ObjectLiteralExpression {
  const factory = context.factory;
  const [head, ...tail] = remaining;
  if (!head) return object;
  const properties = [...object.properties];
  const index = properties.findIndex((property) => {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) return false;
    return (ts.isIdentifier(property.name) ||
      ts.isStringLiteralLike(property.name)) &&
      property.name.text === head;
  });
  if (tail.length === 0) {
    if (index >= 0) {
      throw new Error(
        "FrameworkProvided forwarding attempted to emit a duplicate protected key",
      );
    }
    properties.push(factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      frameworkAlias(root, complete, factory),
    ));
  } else if (index >= 0) {
    const existing = properties[index]!;
    const prefixLength = complete.length - tail.length;
    const prefix = complete.slice(0, prefixLength);
    const child = ts.isPropertyAssignment(existing)
      ? asObjectLiteral(existing.initializer)!
      : publicObjectAliases(root, publicType, prefix, context);
    properties[index] = factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      addForwardedPathToObject(
        child,
        root,
        tail,
        complete,
        publicType,
        context,
      ),
    );
  } else {
    properties.push(factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      addForwardedPathToObject(
        factory.createObjectLiteralExpression(),
        root,
        tail,
        complete,
        publicType,
        context,
      ),
    ));
  }
  return factory.updateObjectLiteralExpression(object, properties);
}

function patternPublicInputType(
  callback: FunctionExpression,
  context: TransformationContext,
): ts.Type | undefined {
  const original = ts.getOriginalNode(callback) as FunctionExpression;
  const descriptor = findEnclosingPatternBuilderCallbackDescriptor(
    original,
    context.checker,
  );
  const source = descriptor?.call.typeArguments?.[0] ??
    original.parameters[0]?.type ?? original.parameters[0];
  if (!source) return undefined;
  try {
    return context.checker.getTypeAtLocation(source);
  } catch {
    return undefined;
  }
}

function publicObjectAliases(
  root: ts.Identifier,
  publicType: ts.Type | undefined,
  path: readonly string[],
  context: TransformationContext,
): ts.ObjectLiteralExpression {
  const target = publicType && typeAtPropertyPath(publicType, path, context);
  if (!target) return context.factory.createObjectLiteralExpression();
  const properties: ts.ObjectLiteralElementLike[] = [];
  for (const property of context.checker.getPropertiesOfType(target)) {
    const name = property.getName();
    if (name.startsWith("__@")) continue;
    properties.push(context.factory.createPropertyAssignment(
      context.factory.createStringLiteral(name),
      frameworkAlias(root, [...path, name], context.factory),
    ));
  }
  return context.factory.createObjectLiteralExpression(properties, true);
}

function typeAtPropertyPath(
  root: ts.Type,
  path: readonly string[],
  context: TransformationContext,
): ts.Type | undefined {
  let current = root;
  for (const segment of path) {
    const property = context.checker.getPropertyOfType(current, segment);
    const declaration = property?.valueDeclaration ??
      property?.declarations?.[0];
    if (!property || !declaration) return undefined;
    current = context.checker.getNonNullableType(
      context.checker.getTypeOfSymbolAtLocation(property, declaration),
    );
  }
  return current;
}

function isSupportedPath(path: readonly string[]): boolean {
  return path.length > 0 &&
    path.every((segment) =>
      segment.length > 0 && segment !== "*" && segment !== "[]" &&
      segment !== "__proto__" && segment !== "prototype" &&
      segment !== "constructor"
    );
}

function frameworkAlias(
  root: ts.Identifier,
  path: readonly string[],
  factory: ts.NodeFactory,
): ts.Expression {
  let value: ts.Expression = factory.createIdentifier(root.text);
  for (const segment of path) {
    value = factory.createCallExpression(
      factory.createPropertyAccessExpression(value, "key"),
      undefined,
      [factory.createStringLiteral(segment)],
    );
  }
  return value;
}

function frameworkPathsForFactoryExpression(
  expression: ts.Expression,
  context: TransformationContext,
  activeNodes: Set<ts.Node>,
  activeSymbols: Set<ts.Symbol>,
): readonly FrameworkProvidedPath[] {
  const source = ts.getOriginalNode(expression) as ts.Expression;
  if (activeNodes.has(source)) return [];
  activeNodes.add(source);
  try {
    try {
      const direct = findFactoryInputFrameworkProvidedPaths(
        context.checker.getTypeAtLocation(source),
        context.checker,
      );
      if (direct.length > 0) return direct;
    } catch {
      // Fall through to declaration tracing for rewritten expressions.
    }

    const target = unwrapExpression(source);
    if (ts.isIdentifier(target)) {
      let symbol = context.checker.getSymbolAtLocation(target);
      if (!symbol || activeSymbols.has(symbol)) return [];
      const active = symbol;
      activeSymbols.add(active);
      try {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = context.checker.getAliasedSymbol(symbol);
        }
        const paths: FrameworkProvidedPath[] = [];
        for (const declaration of symbol.getDeclarations() ?? []) {
          if (
            ts.isVariableDeclaration(declaration) && declaration.initializer
          ) {
            const initializer = unwrapExpression(declaration.initializer);
            if (
              ts.isCallExpression(initializer) &&
              isPatternBuilderCall(initializer, context.checker)
            ) {
              paths.push(...frameworkPathsForPatternBuilder(
                initializer,
                context,
                activeNodes,
                activeSymbols,
              ));
            } else {
              paths.push(...frameworkPathsForFactoryExpression(
                initializer,
                context,
                activeNodes,
                activeSymbols,
              ));
            }
          }
        }
        return mergePaths(paths);
      } finally {
        activeSymbols.delete(active);
      }
    }
    if (ts.isPropertyAccessExpression(target)) {
      return frameworkPathsForFactoryExpression(
        target.expression,
        context,
        activeNodes,
        activeSymbols,
      );
    }
    return [];
  } finally {
    activeNodes.delete(source);
  }
}

function frameworkPathsForPatternBuilder(
  call: ts.CallExpression,
  context: TransformationContext,
  activeNodes: Set<ts.Node>,
  activeSymbols: Set<ts.Symbol>,
): readonly FrameworkProvidedPath[] {
  const descriptor = getPatternBuilderCallbackDescriptor(
    call,
    context.checker,
  );
  if (!descriptor) return [];
  const paths: FrameworkProvidedPath[] = [
    ...frameworkPathsForParameter(descriptor.callback.parameters[0], context),
  ];
  const visit = (node: ts.Node): void => {
    if (node !== descriptor.callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      paths.push(...frameworkPathsForFactoryExpression(
        node.expression,
        context,
        activeNodes,
        activeSymbols,
      ));
    }
    ts.forEachChild(node, visit);
  };
  visit(descriptor.callback.body);
  return mergePaths(paths);
}

function frameworkPathsForParameter(
  parameter: ts.ParameterDeclaration | undefined,
  context: TransformationContext,
): readonly FrameworkProvidedPath[] {
  if (!parameter) return [];
  try {
    return findFrameworkProvidedPaths(
      context.checker.getTypeAtLocation(ts.getOriginalNode(parameter)),
      context.checker,
    );
  } catch {
    return [];
  }
}

function asObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const value = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(value) ? value : undefined;
}

function objectLiteralSuppliesPath(
  object: ts.ObjectLiteralExpression,
  path: readonly string[],
): boolean {
  const [head, ...tail] = path;
  if (!head) return false;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return true;
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) continue;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name)
      ? name.text
      : undefined;
    if (text !== head) continue;
    if (tail.length === 0) return true;
    if (ts.isShorthandPropertyAssignment(property)) return false;
    const initializer = asObjectLiteral(property.initializer);
    return !initializer || objectLiteralSuppliesPath(initializer, tail);
  }
  return false;
}

function pathsExpression(
  paths: readonly FrameworkProvidedPath[],
  factory: ts.NodeFactory,
): ts.ArrayLiteralExpression {
  return factory.createArrayLiteralExpression(
    paths.map((path) =>
      factory.createArrayLiteralExpression(
        path.map((segment) => factory.createStringLiteral(segment)),
      )
    ),
  );
}

function mergePaths(
  ...groups: readonly (readonly FrameworkProvidedPath[])[]
): FrameworkProvidedPath[] {
  const byKey = new Map<string, FrameworkProvidedPath>();
  for (const path of groups.flat()) byKey.set(JSON.stringify(path), [...path]);
  return [...byKey.values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
}

function isInternalFrameworkHelper(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "__cfHelpers" &&
    call.expression.name.text === "withFrameworkProvidedPaths";
}

function updateFunctionParameters(
  callback: FunctionExpression,
  parameters: readonly ts.ParameterDeclaration[],
  factory: ts.NodeFactory,
): FunctionExpression {
  return ts.isArrowFunction(callback)
    ? factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      callback.body,
    )
    : factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      parameters,
      callback.type,
      callback.body,
    );
}

function updateFunctionBody(
  callback: FunctionExpression,
  body: ts.ConciseBody,
  factory: ts.NodeFactory,
): FunctionExpression {
  return ts.isArrowFunction(callback)
    ? factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    )
    : factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      ts.isBlock(body)
        ? body
        : factory.createBlock([factory.createReturnStatement(body)], true),
    );
}
