import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";

export class WriteAuthorizedByValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile } = context;

    const visit: ts.Visitor = (node) => {
      if (isToSchemaNode(node)) {
        const typeArg = node.typeArguments?.[0];
        if (typeArg) {
          validateWriteAuthorizedByUsage(typeArg, context);
        }
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }
}

function isToSchemaNode(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length !== 1) return false;

  if (ts.isIdentifier(expression) && expression.text === "toSchema") {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "toSchema"
  ) {
    return true;
  }

  return false;
}

function validateWriteAuthorizedByUsage(
  typeNode: ts.TypeNode,
  context: TransformationContext,
): void {
  const references = findWriteAuthorizedByReferences(typeNode);
  for (const reference of references) {
    const [schemaType, bindingType] = reference.typeArguments ?? [];
    if (!schemaType || !bindingType || !ts.isTypeQueryNode(bindingType)) {
      context.reportDiagnostic({
        node: reference,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy<T, typeof binding> requires a direct typeof binding reference.",
      });
      continue;
    }

    if (!ts.isIdentifier(bindingType.exprName)) {
      context.reportDiagnostic({
        node: bindingType,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy<T, typeof binding> requires a simple identifier binding.",
      });
      continue;
    }

    if (
      !isSupportedWriteAuthorizedByBindingName(
        bindingType.exprName.text,
        context.sourceFile,
      )
    ) {
      context.reportDiagnostic({
        node: bindingType.exprName,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy only supports local handler(), module(), requireEventIntegrity(), or function-declaration bindings.",
      });
    }
  }
}

function findWriteAuthorizedByReferences(
  node: ts.TypeNode,
): ts.TypeReferenceNode[] {
  const matches: ts.TypeReferenceNode[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(current) &&
      ts.isIdentifier(current.typeName) &&
      current.typeName.text === "WriteAuthorizedBy"
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function isSupportedWriteAuthorizedByBindingName(
  name: string,
  sourceFile: ts.SourceFile,
): boolean {
  let supported = false;

  const visit = (node: ts.Node): void => {
    if (supported) return;

    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      supported = true;
      return;
    }

    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      supported = node.initializer !== undefined;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return supported;
}
