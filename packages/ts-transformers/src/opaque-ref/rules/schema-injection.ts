import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import type { OpaqueRefRule } from "./jsx-expression.ts";
import { detectCallKind } from "../call-kind.ts";

const TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function isSchematizableType(type: ts.Type): boolean {
  const flags = type.getFlags();
  if (flags & ts.TypeFlags.Any) return false;
  if (flags & ts.TypeFlags.Unknown) return false;
  if (flags & ts.TypeFlags.Never) return false;
  return true;
}

function tryCreateTypeNode(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): ts.TypeNode | undefined {
  try {
    return checker.typeToTypeNode(type, location, TYPE_NODE_FLAGS);
  } catch {
    return undefined;
  }
}

function isPromiseLikeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const extendedChecker = checker as ts.TypeChecker & {
    getPromisedTypeOfPromise?: (input: ts.Type) => ts.Type | undefined;
  };
  if (extendedChecker.getPromisedTypeOfPromise) {
    return extendedChecker.getPromisedTypeOfPromise(type) !== undefined;
  }
  if (type.isUnion()) {
    return type.types.some((candidate) =>
      isPromiseLikeType(candidate, checker)
    );
  }
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const name = symbol.getName();
  if (name === "Promise" || name === "PromiseLike") {
    return true;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased) {
      const aliasName = aliased.getName();
      if (aliasName === "Promise" || aliasName === "PromiseLike") {
        return true;
      }
    }
  }
  return false;
}

interface InferredFunctionSchemas {
  argument: { node: ts.TypeNode; type: ts.Type };
  result: { node: ts.TypeNode; type: ts.Type };
}

function inferSchemaTypesFromFunction(
  checker: ts.TypeChecker,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): InferredFunctionSchemas | undefined {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return undefined;

  const parameterSymbol = signature.parameters[0];
  if (!parameterSymbol) return undefined;

  const parameterType = checker.getTypeOfSymbolAtLocation(parameterSymbol, fn);
  if (!isSchematizableType(parameterType)) return undefined;
  const argumentTypeNode = tryCreateTypeNode(checker, parameterType, fn);
  if (!argumentTypeNode) return undefined;

  const returnType = checker.getReturnTypeOfSignature(signature);
  if (isPromiseLikeType(returnType, checker)) return undefined;
  if (!isSchematizableType(returnType)) return undefined;
  const resultTypeNode = tryCreateTypeNode(checker, returnType, fn);
  if (!resultTypeNode) return undefined;

  return {
    argument: { node: argumentTypeNode, type: parameterType },
    result: { node: resultTypeNode, type: returnType },
  };
}

function getParameterTypeNode(
  factory: ts.NodeFactory,
  parameter: ts.ParameterDeclaration | undefined,
): ts.TypeNode {
  return parameter?.type ??
    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

function typeNodeProducesSchema(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
): boolean {
  const type = checker.getTypeFromTypeNode(typeNode);
  return isSchematizableType(type);
}

function updateCallWithSchemas(
  node: ts.CallExpression,
  schemaTypeNodes: readonly ts.TypeNode[],
  transformation: ts.TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  ensureToSchemaImport: () => void,
  remainingArgs: readonly ts.Expression[] = Array.from(node.arguments),
): ts.Node {
  if (schemaTypeNodes.length === 0) return node;
  const factory = transformation.factory;
  const schemaArgs = schemaTypeNodes.map((typeNode) =>
    factory.createCallExpression(
      factory.createIdentifier("toSchema"),
      [typeNode],
      [],
    )
  );

  ensureToSchemaImport();

  const updated = factory.createCallExpression(
    node.expression,
    undefined,
    [...schemaArgs, ...remainingArgs],
  );

  return ts.visitEachChild(updated, visit, transformation);
}

function collectFunctionSchemaTypeNodes(
  checker: ts.TypeChecker,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): { argument?: ts.TypeNode; result?: ts.TypeNode } | undefined {
  let argumentTypeNode: ts.TypeNode | undefined = fn.parameters[0]?.type;
  let resultTypeNode: ts.TypeNode | undefined = fn.type;

  const hasAnnotatedArgument = Boolean(argumentTypeNode);
  const hasAnnotatedResult = Boolean(resultTypeNode);

  if (!hasAnnotatedArgument && !hasAnnotatedResult) {
    return undefined;
  }

  let inferred: InferredFunctionSchemas | undefined;
  if (!argumentTypeNode || !resultTypeNode) {
    inferred = inferSchemaTypesFromFunction(checker, fn);
  }

  const ensureValid = (candidate?: ts.TypeNode): ts.TypeNode | undefined => {
    if (!candidate) return undefined;
    if (!typeNodeProducesSchema(candidate, checker)) return undefined;
    return candidate;
  };

  argumentTypeNode = ensureValid(argumentTypeNode);
  resultTypeNode = ensureValid(resultTypeNode);

  if (!argumentTypeNode && inferred) {
    if (isSchematizableType(inferred.argument.type)) {
      argumentTypeNode = inferred.argument.node;
    }
  }
  if (!resultTypeNode && inferred) {
    if (isSchematizableType(inferred.result.type)) {
      resultTypeNode = inferred.result.node;
    }
  }

  if (!argumentTypeNode && !resultTypeNode) return undefined;

  const collected: { argument?: ts.TypeNode; result?: ts.TypeNode } = {};
  if (argumentTypeNode) {
    collected.argument = argumentTypeNode;
  }
  if (resultTypeNode) {
    collected.result = resultTypeNode;
  }

  return collected;
}

export function createSchemaInjectionRule(): OpaqueRefRule {
  return {
    name: "schema-injection",
    transform(sourceFile, context, transformation) {
      let requestedToSchema = false;

      const ensureToSchemaImport = (): void => {
        if (requestedToSchema) return;
        requestedToSchema = true;
        context.imports.request({ name: "toSchema" });
      };

      const visit = (node: ts.Node): ts.Node => {
        if (!ts.isCallExpression(node)) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const callKind = detectCallKind(node, context.checker);

        if (callKind?.kind === "builder" && callKind.builderName === "recipe") {
          const typeArgs = node.typeArguments;
          if (typeArgs && typeArgs.length >= 1) {
            const argsArray = Array.from(node.arguments);
            let remainingArgs = argsArray;
            if (
              argsArray.length > 0 &&
              argsArray[0] && ts.isStringLiteral(argsArray[0])
            ) {
              remainingArgs = argsArray.slice(1);
            }

            return updateCallWithSchemas(
              node,
              Array.from(typeArgs),
              transformation,
              visit,
              ensureToSchemaImport,
              remainingArgs,
            );
          }
        }

        if (
          callKind?.kind === "builder" && callKind.builderName === "handler"
        ) {
          if (node.typeArguments && node.typeArguments.length >= 2) {
            const eventType = node.typeArguments[0];
            const stateType = node.typeArguments[1];
            if (!eventType || !stateType) {
              return ts.visitEachChild(node, visit, transformation);
            }

            return updateCallWithSchemas(
              node,
              [eventType, stateType],
              transformation,
              visit,
              ensureToSchemaImport,
            );
          }

          if (node.arguments.length === 1) {
            const handlerCandidate = node.arguments[0];
            if (
              handlerCandidate &&
              (ts.isFunctionExpression(handlerCandidate) ||
                ts.isArrowFunction(handlerCandidate))
            ) {
              const handlerFn = handlerCandidate;
              if (handlerFn.parameters.length >= 2) {
                const eventParam = handlerFn.parameters[0];
                const stateParam = handlerFn.parameters[1];
                if (eventParam || stateParam) {
                  const eventType = getParameterTypeNode(
                    transformation.factory,
                    eventParam,
                  );
                  const stateType = getParameterTypeNode(
                    transformation.factory,
                    stateParam,
                  );

                  return updateCallWithSchemas(
                    node,
                    [eventType, stateType],
                    transformation,
                    visit,
                    ensureToSchemaImport,
                    [handlerFn],
                  );
                }
              }
            }
          }
        }

        if (callKind?.kind === "derive") {
          if (
            (!node.typeArguments || node.typeArguments.length === 0) &&
            node.arguments.length === 2
          ) {
            const callback = node.arguments[1];
            if (callback && isFunctionLikeExpression(callback)) {
              const collected = collectFunctionSchemaTypeNodes(
                context.checker,
                callback,
              );
              if (collected) {
                const schemaTypeNodes: ts.TypeNode[] = [
                  collected.argument ??
                    transformation.factory.createKeywordTypeNode(
                      ts.SyntaxKind.UnknownKeyword,
                    ),
                  collected.result ??
                    transformation.factory.createKeywordTypeNode(
                      ts.SyntaxKind.UnknownKeyword,
                    ),
                ];

                if (collected.argument || collected.result) {
                  return updateCallWithSchemas(
                    node,
                    schemaTypeNodes,
                    transformation,
                    visit,
                    ensureToSchemaImport,
                  );
                }
              }
            }
          }

          if (node.typeArguments && node.typeArguments.length >= 2) {
            const argumentType = node.typeArguments[0];
            const resultType = node.typeArguments[1];
            if (!argumentType || !resultType) {
              return ts.visitEachChild(node, visit, transformation);
            }

            return updateCallWithSchemas(
              node,
              [argumentType, resultType],
              transformation,
              visit,
              ensureToSchemaImport,
            );
          }
        }

        if (callKind?.kind === "builder" && callKind.builderName === "lift") {
          if (
            (!node.typeArguments || node.typeArguments.length === 0) &&
            node.arguments.length === 1
          ) {
            const implementation = node.arguments[0];
            if (implementation && isFunctionLikeExpression(implementation)) {
              const collected = collectFunctionSchemaTypeNodes(
                context.checker,
                implementation,
              );
              if (collected) {
                const schemaTypeNodes: ts.TypeNode[] = [
                  collected.argument ??
                    transformation.factory.createKeywordTypeNode(
                      ts.SyntaxKind.UnknownKeyword,
                    ),
                  collected.result ??
                    transformation.factory.createKeywordTypeNode(
                      ts.SyntaxKind.UnknownKeyword,
                    ),
                ];

                if (collected.argument || collected.result) {
                  return updateCallWithSchemas(
                    node,
                    schemaTypeNodes,
                    transformation,
                    visit,
                    ensureToSchemaImport,
                  );
                }
              }
            }
          }

          if (node.typeArguments && node.typeArguments.length >= 2) {
            const argumentType = node.typeArguments[0];
            const resultType = node.typeArguments[1];
            if (!argumentType || !resultType) {
              return ts.visitEachChild(node, visit, transformation);
            }

            return updateCallWithSchemas(
              node,
              [argumentType, resultType],
              transformation,
              visit,
              ensureToSchemaImport,
            );
          }
        }

        return ts.visitEachChild(node, visit, transformation);
      };

      return ts.visitEachChild(sourceFile, visit, transformation);
    },
  };
}
