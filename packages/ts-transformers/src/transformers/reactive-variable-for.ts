import ts from "typescript";

import {
  classifyArrayMethodCallSite,
  detectCallKind,
  detectDirectBuilderCall,
  getTypeAtLocationWithFallback,
  isCellLikeType,
} from "../ast/mod.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class ReactiveVariableForTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createReactiveVariableForVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

function createReactiveVariableForVisitor(
  context: TransformationContext,
): ts.Visitor {
  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    if (ts.isPropertyAssignment(node)) {
      const visited = ts.visitEachChild(
        node,
        visit,
        context.tsContext,
      ) as ts.PropertyAssignment;

      const propertyName = getStablePropertyName(visited.name);
      if (
        !propertyName ||
        isInternalSyntheticName(propertyName) ||
        !shouldAddPropertyFor(visited.initializer, context)
      ) {
        return visited;
      }

      return context.factory.updatePropertyAssignment(
        visited,
        visited.name,
        createForCall(visited.initializer, propertyName, context),
      );
    }

    if (!ts.isVariableDeclarationList(node)) {
      return ts.visitEachChild(node, visit, context.tsContext);
    }

    const visited = ts.visitEachChild(
      node,
      visit,
      context.tsContext,
    ) as ts.VariableDeclarationList;

    if ((visited.flags & ts.NodeFlags.Const) === 0) {
      return visited;
    }

    let changed = false;
    const declarations = visited.declarations.map((declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        isInternalSyntheticName(declaration.name.text) ||
        !declaration.initializer ||
        !shouldAddVariableFor(declaration.initializer, context)
      ) {
        return declaration;
      }

      changed = true;
      return context.factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        createForCall(
          declaration.initializer,
          declaration.name.text,
          context,
        ),
      );
    });

    return changed
      ? context.factory.updateVariableDeclarationList(
        visited,
        declarations,
      )
      : visited;
  };

  return visit;
}

function shouldAddVariableFor(
  initializer: ts.Expression,
  context: TransformationContext,
): boolean {
  return shouldAddReactiveFor(initializer, context, {
    includeRuntimeCalls: true,
    useTypeFallback: true,
  });
}

function shouldAddPropertyFor(
  initializer: ts.Expression,
  context: TransformationContext,
): boolean {
  return shouldAddReactiveFor(initializer, context, {
    includeRuntimeCalls: false,
    useTypeFallback: false,
  });
}

function shouldAddReactiveFor(
  initializer: ts.Expression,
  context: TransformationContext,
  options: {
    includeRuntimeCalls: boolean;
    useTypeFallback: boolean;
  },
): boolean {
  if (chainContainsForCall(initializer)) {
    return false;
  }

  const expression = unwrapExpression(initializer);
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (isReactiveArrayMethodCall(expression, context)) {
    return true;
  }

  const callKind = detectCallKind(expression, context.checker);
  if (callKind) {
    switch (callKind.kind) {
      case "array-method":
        return isReactiveArrayMethodCall(expression, context);
      case "builder":
        return isReactiveBuilderResult(
          expression,
          callKind.builderName,
          context,
        );
      case "cell-factory":
      case "derive":
      case "ifElse":
      case "when":
      case "unless":
      case "wish":
      case "generate-text":
      case "generate-object":
        return true;
      case "runtime-call":
        return options.includeRuntimeCalls && callKind.reactiveOrigin;
      case "cell-for":
      case "pattern-tool":
        return false;
    }
  }

  if (!options.useTypeFallback) {
    return false;
  }

  const type = getTypeAtLocationWithFallback(
    expression,
    context.checker,
    context.options.typeRegistry,
    context.options.logger,
  );
  return isCellLikeType(type, context.checker);
}

function isInternalSyntheticName(name: string): boolean {
  return name.startsWith("__cf");
}

function getStablePropertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  if (!ts.isComputedPropertyName(name)) {
    return undefined;
  }

  const expression = unwrapExpression(name.expression);
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression)
  ) {
    return expression.text;
  }

  return undefined;
}

function isReactiveBuilderResult(
  call: ts.CallExpression,
  builderName: string,
  context: TransformationContext,
): boolean {
  const direct = detectDirectBuilderCall(call, context.checker);
  if (!direct) {
    return true;
  }

  return builderName === "action" || builderName === "computed";
}

function isReactiveArrayMethodCall(
  call: ts.CallExpression,
  context: TransformationContext,
): boolean {
  return classifyArrayMethodCallSite(call, context.checker)?.ownership ===
    "reactive";
}

function chainContainsForCall(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);

  while (ts.isCallExpression(current)) {
    const target = unwrapExpression(current.expression);
    if (isForAccess(target)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ) {
      current = unwrapExpression(target.expression);
      continue;
    }
    break;
  }

  return false;
}

function isForAccess(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "for";
  }

  if (!ts.isElementAccessExpression(expression)) {
    return false;
  }

  const argument = expression.argumentExpression;
  return !!argument &&
    (
      ts.isStringLiteralLike(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument)
    ) &&
    argument.text === "for";
}

function createForCall(
  initializer: ts.Expression,
  variableName: string,
  context: TransformationContext,
): ts.Expression {
  const call = context.factory.createCallExpression(
    context.factory.createPropertyAccessExpression(initializer, "for"),
    undefined,
    [
      context.factory.createStringLiteral(variableName),
      context.factory.createTrue(),
    ],
  );
  return context.cfHelpers.preserveNodeSourceMap(
    call,
    initializer,
    initializer,
  );
}
