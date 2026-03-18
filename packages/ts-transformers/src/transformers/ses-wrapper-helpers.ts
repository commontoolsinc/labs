import ts from "typescript";
import { CT_HELPERS_IDENTIFIER } from "../core/ct-helpers.ts";

export const SES_SENTINEL_PREFIX = "__CT_TOPLEVEL__:";

export type SESWrapperKind = "builder" | "fn" | "pure-fn" | "data";

export function createSESHelperExpr(
  factory: ts.NodeFactory,
  helperName: "__ct_builder" | "__ct_fn" | "__ct_pure_fn" | "__ct_data",
): ts.PropertyAccessExpression {
  return factory.createPropertyAccessExpression(
    factory.createIdentifier(CT_HELPERS_IDENTIFIER),
    helperName,
  );
}

export function createSESItemId(
  sourceFile: ts.SourceFile,
  ordinal: number,
  localName: string,
): string {
  return `${normalizePath(sourceFile.fileName)}#${
    String(ordinal).padStart(3, "0")
  }:${localName}`;
}

export function createSESSentinelText(
  sourceFile: ts.SourceFile,
  ordinal: number,
  localName: string,
  kind: SESWrapperKind,
): string {
  return `${SES_SENTINEL_PREFIX}${normalizePath(sourceFile.fileName)}:${
    String(ordinal).padStart(3, "0")
  }:${localName}:${kind}`;
}

export function addSESSentinel<T extends ts.Node>(
  node: T,
  sourceFile: ts.SourceFile,
  ordinal: number,
  localName: string,
  kind: SESWrapperKind,
): T {
  return ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    createSESSentinelText(sourceFile, ordinal, localName, kind),
    true,
  ) as T;
}

export function toDirectFunctionExpression(
  factory: ts.NodeFactory,
  expression: ts.FunctionLikeDeclarationBase,
): ts.FunctionExpression {
  const body = expression.body && ts.isBlock(expression.body)
    ? expression.body
    : factory.createBlock(
      [
        factory.createReturnStatement(
          expression.body as ts.Expression | undefined,
        ),
      ],
      true,
    );

  return factory.createFunctionExpression(
    undefined,
    undefined,
    undefined,
    undefined,
    expression.parameters,
    undefined,
    body,
  );
}

export function collectReferencedIdentifiers(
  node: ts.Node,
  allowedBindings: ReadonlySet<string>,
): string[] {
  const names = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }
    if (
      ts.isIdentifier(current) &&
      !isPropertyName(current) &&
      allowedBindings.has(current.text)
    ) {
      names.add(current.text);
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  return [...names];
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  return false;
}

function normalizePath(fileName: string): string {
  return fileName.replace(/\\/g, "/").replace(/^\//, "");
}
