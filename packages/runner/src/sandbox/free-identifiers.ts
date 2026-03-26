import ts from "typescript";

export function collectFreeIdentifiersFromTsFunction(
  fn: ts.FunctionLikeDeclaration,
): Set<string> {
  const free = new Set<string>();
  const scopes: Array<Set<string>> = [];

  const withScope = (bindings: string[], callback: () => void) => {
    scopes.push(new Set(bindings));
    callback();
    scopes.pop();
  };
  const addBinding = (name: ts.BindingName) => {
    const scope = scopes[scopes.length - 1];
    if (!scope) return;
    for (const binding of bindingNames(name)) {
      scope.add(binding);
    }
  };
  const isBound = (name: string) => scopes.some((scope) => scope.has(name));
  const visitNestedFunction = (node: ts.FunctionLikeDeclaration) => {
    const nestedBindings = [
      ...(node.name && ts.isIdentifier(node.name) ? [node.name.text] : []),
      ...node.parameters.flatMap((parameter: ts.ParameterDeclaration) =>
        bindingNames(parameter.name)
      ),
    ];
    withScope(nestedBindings, () => {
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visit(parameter.initializer);
        }
      }
      if (node.body) {
        visit(node.body);
      }
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;

    if (isTrackedFunctionLike(node) && node !== fn) {
      visitNestedFunction(node);
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      const hoistedBindings = node.statements.flatMap((statement) =>
        ts.isFunctionDeclaration(statement) && statement.name
          ? [statement.name.text]
          : []
      );
      withScope(hoistedBindings, () => ts.forEachChild(node, visit));
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer);
      addBinding(node.name);
      return;
    }

    if (ts.isParameter(node)) {
      if (node.initializer) visit(node.initializer);
      addBinding(node.name);
      return;
    }

    if (ts.isCatchClause(node)) {
      const names = node.variableDeclaration
        ? bindingNames(node.variableDeclaration.name)
        : [];
      withScope(names, () => visit(node.block));
      return;
    }

    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      if (!isBound(node.text)) {
        free.add(node.text);
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  const initialBindings = [
    ...(fn.name && ts.isIdentifier(fn.name) ? [fn.name.text] : []),
    ...fn.parameters.flatMap((parameter: ts.ParameterDeclaration) =>
      bindingNames(parameter.name)
    ),
  ];
  withScope(initialBindings, () => {
    if (fn.body) visit(fn.body);
  });
  return free;
}

export function parseFunctionLikeFromExpressionText(
  text: string,
  filename = "<function>",
): ts.FunctionLikeDeclaration {
  const sourceFile = ts.createSourceFile(
    filename,
    `const __ct_capture_probe__ = ${text};`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error("Expected a direct function expression");
  }

  const declaration = statement.declarationList.declarations[0];
  let initializer = declaration?.initializer;
  while (initializer && ts.isParenthesizedExpression(initializer)) {
    initializer = initializer.expression;
  }

  if (!initializer || !isTrackedFunctionLike(initializer)) {
    throw new Error("Expected a direct function expression");
  }

  return initializer;
}

export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element: ts.ArrayBindingElement) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function isTrackedFunctionLike(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAccessExpression(parent) && parent.name === node ||
    ts.isPropertyAssignment(parent) && parent.name === node ||
    ts.isShorthandPropertyAssignment(parent) && parent.name === node ||
    ts.isMethodDeclaration(parent) && parent.name === node ||
    ts.isPropertyDeclaration(parent) && parent.name === node ||
    ts.isBindingElement(parent) && parent.propertyName === node ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isJsxAttribute(parent) && parent.name === node ||
    (
        ts.isJsxOpeningElement(parent) ||
        ts.isJsxSelfClosingElement(parent) ||
        ts.isJsxClosingElement(parent)
      ) && parent.tagName === node ||
    ts.isTypeReferenceNode(parent) ||
    ts.isExpressionWithTypeArguments(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isLabeledStatement(parent) && parent.label === node ||
    ts.isBreakOrContinueStatement(parent) && parent.label === node
  ) {
    return false;
  }
  return true;
}
