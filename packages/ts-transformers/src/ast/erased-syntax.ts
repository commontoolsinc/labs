import ts from "typescript";

/**
 * Whether `node`, and everything under it, is erased at emit, so that no name
 * written there refers to a runtime value: a type, an interface or type alias
 * declaration, an `implements` clause or an interface's `extends` clause, a
 * class's index signature, and a declaration with no body (an overload
 * signature or an abstract member).
 *
 * `ExpressionWithTypeArguments` is the one type node that can hold a value.
 * The expression of a class's `extends` clause, and of an instantiation
 * expression such as `factory<string>`, is evaluated; only its type arguments
 * are erased, and each of those is a type node of its own.
 */
export function isErasedAtEmit(node: ts.Node): boolean {
  if (ts.isExpressionWithTypeArguments(node)) {
    const clause = node.parent;
    return clause !== undefined && ts.isHeritageClause(clause) &&
      (clause.token === ts.SyntaxKind.ImplementsKeyword ||
        ts.isInterfaceDeclaration(clause.parent));
  }
  if (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isIndexSignatureDeclaration(node)
  ) {
    return true;
  }
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isAccessor(node)) &&
    node.body === undefined;
}
