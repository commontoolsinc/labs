import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

const REWRITABLE_HELPERS = new Map([
  ["Date.now", "safeDateNow"],
  ["Math.random", "nonPrivateRandom"],
]);

export class TimeRandomHelperRewriteTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isTypeNode(node)) {
        return node;
      }

      if (ts.isCallExpression(node)) {
        const rewritten = rewriteAmbientCall(node, context);
        if (rewritten) {
          return rewritten;
        }
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function rewriteAmbientCall(
  node: ts.CallExpression,
  context: TransformationContext,
): ts.CallExpression | undefined {
  const target = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const owner = unwrapExpression(target.expression);
  if (!ts.isIdentifier(owner)) {
    return undefined;
  }

  const helperName = REWRITABLE_HELPERS.get(
    `${owner.text}.${target.name.text}`,
  );
  if (!helperName) {
    return undefined;
  }

  if (!isAmbientBuiltinReference(owner, context)) {
    return undefined;
  }

  return context.factory.createCallExpression(
    context.ctHelpers.getHelperExpr(helperName),
    node.typeArguments,
    node.arguments,
  );
}

function isAmbientBuiltinReference(
  identifier: ts.Identifier,
  context: TransformationContext,
): boolean {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol?.declarations?.length) {
    return false;
  }

  return symbol.declarations.every((declaration) =>
    declaration.getSourceFile().isDeclarationFile
  );
}
