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
    getFunctionModifiers(expression),
    ts.isFunctionDeclaration(expression) || ts.isFunctionExpression(expression)
      ? expression.asteriskToken
      : undefined,
    ts.isFunctionDeclaration(expression) || ts.isFunctionExpression(expression)
      ? expression.name
      : undefined,
    expression.typeParameters,
    expression.parameters,
    expression.type,
    body,
  );
}

export function collectReferencedIdentifiers(
  node: ts.Node,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
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
      !isDeclarationName(current) &&
      !isTypePosition(current) &&
      resolvesToTopLevelBinding(current, checker, sourceFile) &&
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

function getFunctionModifiers(
  expression: ts.FunctionLikeDeclarationBase,
): readonly ts.Modifier[] | undefined {
  if (
    !ts.isArrowFunction(expression) &&
    !ts.isFunctionDeclaration(expression) &&
    !ts.isFunctionExpression(expression)
  ) {
    return undefined;
  }

  const modifiers = expression.modifiers?.filter(
    (modifier): modifier is ts.Modifier =>
      modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );
  return modifiers as readonly ts.Modifier[] | undefined;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return ts.isPropertySignature(parent) && parent.name === node;
}

function isTypePosition(node: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (
      ts.isExpression(current) || ts.isStatement(current) ||
      ts.isSourceFile(current)
    ) {
      return false;
    }
  }
  return false;
}

function resolvesToTopLevelBinding(
  node: ts.Identifier,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }

  const candidates = new Set<ts.Symbol>([symbol]);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    candidates.add(checker.getAliasedSymbol(symbol));
  }

  for (const candidate of candidates) {
    if ((candidate.declarations ?? []).some((declaration) =>
      isTopLevelDeclaration(declaration, sourceFile)
    )) {
      return true;
    }
  }

  return false;
}

function isTopLevelDeclaration(
  declaration: ts.Declaration,
  sourceFile: ts.SourceFile,
): boolean {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (current === sourceFile) {
      return true;
    }
    if (
      current !== declaration &&
      (
        ts.isBlock(current) || ts.isFunctionLike(current) ||
        ts.isClassDeclaration(current) || ts.isClassExpression(current)
      )
    ) {
      return false;
    }
  }
  return false;
}

function normalizePath(fileName: string): string {
  return fileName.replace(/\\/g, "/").replace(/^\//, "");
}
