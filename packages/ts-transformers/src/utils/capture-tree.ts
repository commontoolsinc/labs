import ts from "typescript";

import { unwrapExpression } from "./expression.ts";
import { isSafeIdentifierText } from "./identifiers.ts";

export interface CapturePathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly expression: ts.Expression;
}

export interface CaptureTreeNode {
  readonly properties: Map<string, CaptureTreeNode>;
  readonly path: readonly string[];
  expression?: ts.Expression;
}

export function parseCaptureExpression(
  expr: ts.Expression,
): CapturePathInfo | undefined {
  // Unwrap non-semantic wrappers (parens, `as`, type assertions, `satisfies`,
  // `!`, partially-emitted) so wrapped reads like `(entry).name` and
  // `entry!.name` parse the same way as the bare form. Without this, the
  // capture would fall into the unstructured "fallback" bucket downstream
  // and lose its partial-key dataflow shape.
  const unwrapped = unwrapExpression(expr);

  if (ts.isIdentifier(unwrapped)) {
    return { root: unwrapped.text, path: [], expression: expr };
  }

  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "key"
    ) {
      const receiver = parseCaptureExpression(callee.expression);
      if (!receiver) {
        return undefined;
      }

      const keySegments: string[] = [];
      for (const arg of unwrapped.arguments) {
        if (
          ts.isStringLiteralLike(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg)
        ) {
          keySegments.push(arg.text);
          continue;
        }
        return undefined;
      }

      return {
        root: receiver.root,
        path: [...receiver.path, ...keySegments],
        expression: expr,
      };
    }
  }

  if (ts.isPropertyAccessExpression(unwrapped)) {
    const segments: string[] = [];
    let current: ts.Expression = unwrapped;

    while (ts.isPropertyAccessExpression(current)) {
      // If we encounter optional chaining (e.g., foo?.bar), stop here and
      // capture just the expression before the optional chain.
      // This preserves nullability in the schema - the root object might be
      // null/undefined, so we shouldn't descend into its properties.
      if (ts.isPropertyAccessChain(current)) {
        // The expression before the ?. is our capture target
        const beforeChain = unwrapExpression(current.expression);
        if (ts.isIdentifier(beforeChain)) {
          return { root: beforeChain.text, path: [], expression: beforeChain };
        }
        // If it's a nested property access before the chain (e.g., a.b?.c),
        // recursively parse that part
        if (ts.isPropertyAccessExpression(beforeChain)) {
          return parseCaptureExpression(beforeChain);
        }
        // Can't parse this expression
        return undefined;
      }
      segments.unshift(current.name.text);
      // Unwrap at every descent step so wrappers anywhere in the chain
      // (e.g. `((entry).name).x`) don't break the walk.
      current = unwrapExpression(current.expression);
    }

    if (ts.isIdentifier(current)) {
      return { root: current.text, path: segments, expression: expr };
    }
  }

  return undefined;
}

export function createCaptureTreeNode(
  path: readonly string[],
): CaptureTreeNode {
  return { properties: new Map(), path };
}

function ensureChildNode(
  parent: CaptureTreeNode,
  key: string,
): CaptureTreeNode {
  let child = parent.properties.get(key);
  if (!child) {
    child = createCaptureTreeNode([...parent.path, key]);
    parent.properties.set(key, child);
  }
  return child;
}

export function groupCapturesByRoot(
  captureExpressions: Iterable<ts.Expression>,
): Map<string, CaptureTreeNode> {
  const rootMap = new Map<string, CaptureTreeNode>();

  for (const expr of captureExpressions) {
    const pathInfo = parseCaptureExpression(expr);
    if (!pathInfo) continue;

    const { root, path, expression } = pathInfo;
    let rootNode = rootMap.get(root);
    if (!rootNode) {
      rootNode = createCaptureTreeNode([]);
      rootMap.set(root, rootNode);
    }

    let currentNode = rootNode;

    if (path.length === 0) {
      currentNode.expression = expression;
      currentNode.properties.clear();
      continue;
    }

    if (currentNode.expression) {
      continue;
    }

    for (const segment of path) {
      currentNode = ensureChildNode(currentNode, segment);
      if (currentNode.expression) {
        break;
      }
    }

    if (!currentNode.expression) {
      currentNode.expression = expression;
      currentNode.properties.clear();
    }
  }

  return rootMap;
}

export function createCaptureAccessExpression(
  rootName: string,
  path: readonly string[],
  factory: ts.NodeFactory,
  template?: ts.Expression,
): ts.Expression {
  if (template) {
    if (
      ts.isCallExpression(template) &&
      ts.isPropertyAccessExpression(template.expression) &&
      template.expression.name.text === "key"
    ) {
      return template;
    }

    const rebuild = (expr: ts.Expression): ts.Expression | undefined => {
      if (ts.isIdentifier(expr)) {
        return factory.createIdentifier(rootName);
      }
      if (ts.isPropertyAccessExpression(expr)) {
        const target = rebuild(expr.expression);
        if (!target) return undefined;
        if (ts.isPropertyAccessChain(expr)) {
          return factory.createPropertyAccessChain(
            target,
            factory.createToken(ts.SyntaxKind.QuestionDotToken),
            expr.name,
          );
        }
        return factory.createPropertyAccessExpression(target, expr.name);
      }
      if (ts.isElementAccessExpression(expr)) {
        const target = rebuild(expr.expression);
        if (!target) return undefined;
        if (ts.isElementAccessChain(expr)) {
          return factory.createElementAccessChain(
            target,
            factory.createToken(ts.SyntaxKind.QuestionDotToken),
            expr.argumentExpression,
          );
        }
        return factory.createElementAccessExpression(
          target,
          expr.argumentExpression,
        );
      }
      return undefined;
    };

    const rebuilt = rebuild(template);
    if (rebuilt) {
      return rebuilt;
    }
  }

  let expr: ts.Expression = factory.createIdentifier(rootName);
  for (const segment of path) {
    expr = factory.createPropertyAccessExpression(
      expr,
      factory.createIdentifier(segment),
    );
  }
  return expr;
}

export function buildHierarchicalParamsValue(
  node: CaptureTreeNode,
  rootName: string,
  factory: ts.NodeFactory,
): ts.Expression {
  if (node.expression && node.properties.size === 0) {
    return createCaptureAccessExpression(
      rootName,
      node.path,
      factory,
      node.expression,
    );
  }

  const assignments: ts.PropertyAssignment[] = [];
  for (const [propName, childNode] of node.properties) {
    assignments.push(
      factory.createPropertyAssignment(
        isSafeIdentifierText(propName)
          ? factory.createIdentifier(propName)
          : factory.createStringLiteral(propName),
        buildHierarchicalParamsValue(childNode, rootName, factory),
      ),
    );
  }

  if (assignments.length === 0 && node.expression) {
    return createCaptureAccessExpression(
      rootName,
      node.path,
      factory,
      node.expression,
    );
  }

  return factory.createObjectLiteralExpression(
    assignments,
    assignments.length > 0,
  );
}

export function buildCapturePropertyAssignments(
  captureTree: Iterable<[string, CaptureTreeNode]>,
  factory: ts.NodeFactory,
  renameMap?: ReadonlyMap<string, string>,
): ts.PropertyAssignment[] {
  const properties: ts.PropertyAssignment[] = [];
  for (const [rootName, node] of captureTree) {
    const propertyName = renameMap?.get(rootName) ?? rootName;
    properties.push(
      factory.createPropertyAssignment(
        isSafeIdentifierText(propertyName)
          ? factory.createIdentifier(propertyName)
          : factory.createStringLiteral(propertyName),
        buildHierarchicalParamsValue(node, rootName, factory),
      ),
    );
  }
  return properties;
}
