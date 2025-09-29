import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import type { OpaqueRefRule } from "./jsx-expression.ts";
import { detectCallKind } from "../call-kind.ts";
import { isOpaqueRefType } from "../types.ts";

const TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function isPromiseLikeType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const extended = checker as ts.TypeChecker & {
    getPromisedTypeOfPromise?: (type: ts.Type) => ts.Type | undefined;
  };
  if (extended.getPromisedTypeOfPromise) {
    const promised = extended.getPromisedTypeOfPromise(type);
    if (promised) return true;
  }
  if (type.isUnion()) {
    return type.types.some((candidate) =>
      isPromiseLikeType(candidate, checker)
    );
  }
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const name = symbol.getName();
  if (name === "Promise" || name === "PromiseLike") return true;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (!aliased) return false;
    const aliasName = aliased.getName();
    return aliasName === "Promise" || aliasName === "PromiseLike";
  }
  return false;
}

function isAnyType(type: ts.Type | undefined): boolean {
  return !!type && (type.flags & ts.TypeFlags.Any) !== 0;
}

function inferReturnTypeFromBody(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const body = fn.body;
  if (!body) return undefined;
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        return checker.getTypeAtLocation(statement.expression);
      }
    }
    const extended = checker as ts.TypeChecker & {
      getVoidType?: () => ts.Type;
    };
    return extended.getVoidType ? extended.getVoidType() : undefined;
  }
  return checker.getTypeAtLocation(body);
}

function isInsideJsx(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isJsxExpression(current) ||
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxAttribute(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function getTypeReferenceArgument(type: ts.Type): ts.Type | undefined {
  if ("aliasTypeArguments" in type && type.aliasTypeArguments) {
    const [arg] = type.aliasTypeArguments;
    if (arg) return arg;
  }
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const ref = objectType as ts.TypeReference;
      if (ref.typeArguments && ref.typeArguments.length > 0) {
        return ref.typeArguments[0];
      }
    }
  }
  return undefined;
}

function unwrapOpaqueLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): ts.Type | undefined {
  if (!type) return undefined;
  if (seen.has(type)) return type;
  seen.add(type);

  if (type.isUnion()) {
    const unwrapped = type.types.map((candidate) =>
      unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
    );
    const merged = (checker as ts.TypeChecker & {
      getUnionType?: (types: readonly ts.Type[], node?: ts.Node) => ts.Type;
    }).getUnionType?.(unwrapped) ?? type;
    return merged;
  }

  if (type.isIntersection()) {
    const intersection = (checker as ts.TypeChecker & {
      getIntersectionType?: (types: readonly ts.Type[]) => ts.Type;
    }).getIntersectionType;
    if (intersection) {
      const parts = type.types.map((candidate) =>
        unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
      );
      return intersection(parts);
    }
    return type;
  }

  if (isOpaqueRefType(type, checker)) {
    const inner = unwrapOpaqueLikeType(
      getTypeReferenceArgument(type),
      checker,
      seen,
    );
    if (inner) return inner;
  }

  return type;
}

function typeToSchemaTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.TypeNode | undefined {
  const normalized = unwrapOpaqueLikeType(type, checker);
  if (!normalized) return undefined;
  try {
    return checker.typeToTypeNode(normalized, location, TYPE_NODE_FLAGS);
  } catch {
    return undefined;
  }
}

function collectFunctionSchemaTypeNodes(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  fallbackArgType?: ts.Type,
): {
  argument?: ts.TypeNode;
  result?: ts.TypeNode;
} {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return {};

  const parameter = fn.parameters.length > 0 ? fn.parameters[0] : undefined;
  let argumentNode: ts.TypeNode | undefined;
  const resolveArgumentNode = (
    type: ts.Type | undefined,
    location: ts.Node,
  ): ts.TypeNode | undefined => {
    if (!type) return undefined;
    if (isAnyType(type) && fallbackArgType) {
      type = fallbackArgType;
    }
    return typeToSchemaTypeNode(type, checker, location);
  };

  if (parameter?.type) {
    argumentNode = parameter.type;
  } else if (parameter) {
    argumentNode = resolveArgumentNode(
      checker.getTypeAtLocation(parameter),
      parameter,
    );
  } else if (signature.parameters.length > 0) {
    const parameterSymbol = signature.parameters[0];
    if (parameterSymbol) {
      argumentNode = resolveArgumentNode(
        checker.getTypeOfSymbolAtLocation(
          parameterSymbol,
          parameterSymbol.valueDeclaration ?? fn,
        ),
        fn,
      );
    }
  }

  if (!argumentNode && fallbackArgType) {
    argumentNode = typeToSchemaTypeNode(fallbackArgType, checker, fn);
  }

  const rawReturnType = checker.getReturnTypeOfSignature(signature);
  if (isPromiseLikeType(rawReturnType, checker)) {
    const result: { argument?: ts.TypeNode; result?: ts.TypeNode } = {};
    if (argumentNode) result.argument = argumentNode;
    return result;
  }
  let returnTypeForSchema = rawReturnType;
  if (isAnyType(returnTypeForSchema)) {
    const inferredReturn = inferReturnTypeFromBody(fn, checker);
    if (inferredReturn && !isAnyType(inferredReturn)) {
      returnTypeForSchema = inferredReturn;
    }
  }
  const resultNode = typeToSchemaTypeNode(returnTypeForSchema, checker, fn);

  const result: { argument?: ts.TypeNode; result?: ts.TypeNode } = {};
  if (argumentNode) result.argument = argumentNode;
  if (resultNode) result.result = resultNode;
  return result;
}

function createToSchemaCall(
  factory: ts.NodeFactory,
  typeNode: ts.TypeNode,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier("toSchema"),
    [typeNode],
    [],
  );
}

function prependSchemaArguments(
  factory: ts.NodeFactory,
  node: ts.CallExpression,
  argumentType: ts.TypeNode,
  resultType: ts.TypeNode,
): ts.CallExpression {
  return factory.createCallExpression(
    node.expression,
    undefined,
    [
      createToSchemaCall(factory, argumentType),
      createToSchemaCall(factory, resultType),
      ...node.arguments,
    ],
  );
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
            const factory = transformation.factory;
            const schemaArgs = typeArgs.map((typeArg) => typeArg).map((
              typeArg,
            ) =>
              factory.createCallExpression(
                factory.createIdentifier("toSchema"),
                [typeArg],
                [],
              )
            );

            const argsArray = Array.from(node.arguments);
            let remainingArgs = argsArray;
            if (
              argsArray.length > 0 &&
              argsArray[0] && ts.isStringLiteral(argsArray[0])
            ) {
              remainingArgs = argsArray.slice(1);
            }

            ensureToSchemaImport();

            const updated = factory.createCallExpression(
              node.expression,
              undefined,
              [...schemaArgs, ...remainingArgs],
            );

            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        if (
          callKind?.kind === "builder" && callKind.builderName === "handler"
        ) {
          const factory = transformation.factory;

          if (node.typeArguments && node.typeArguments.length >= 2) {
            const eventType = node.typeArguments[0];
            const stateType = node.typeArguments[1];
            if (!eventType || !stateType) {
              return ts.visitEachChild(node, visit, transformation);
            }
            const toSchemaEvent = factory.createCallExpression(
              factory.createIdentifier("toSchema"),
              [eventType],
              [],
            );
            const toSchemaState = factory.createCallExpression(
              factory.createIdentifier("toSchema"),
              [stateType],
              [],
            );

            ensureToSchemaImport();

            const updated = factory.createCallExpression(
              node.expression,
              undefined,
              [toSchemaEvent, toSchemaState, ...node.arguments],
            );

            return ts.visitEachChild(updated, visit, transformation);
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
                const eventType = eventParam?.type ??
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
                const stateType = stateParam?.type ??
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

                if (eventParam || stateParam) {
                  const toSchemaEvent = factory.createCallExpression(
                    factory.createIdentifier("toSchema"),
                    [eventType],
                    [],
                  );
                  const toSchemaState = factory.createCallExpression(
                    factory.createIdentifier("toSchema"),
                    [stateType],
                    [],
                  );

                  ensureToSchemaImport();

                  const updated = factory.createCallExpression(
                    node.expression,
                    undefined,
                    [toSchemaEvent, toSchemaState, handlerFn],
                  );

                  return ts.visitEachChild(updated, visit, transformation);
                }
              }
            }
          }
        }

        if (callKind?.kind === "derive") {
          const factory = transformation.factory;
          const insideJsx = isInsideJsx(node);
          const updateWithSchemas = (
            argumentType: ts.TypeNode,
            resultType: ts.TypeNode,
          ): ts.Node => {
            ensureToSchemaImport();
            const updated = prependSchemaArguments(
              factory,
              node,
              argumentType,
              resultType,
            );
            return ts.visitEachChild(updated, visit, transformation);
          };

          if (node.typeArguments && node.typeArguments.length >= 2) {
            const [argumentType, resultType] = node.typeArguments;
            if (!argumentType || !resultType) {
              return ts.visitEachChild(node, visit, transformation);
            }

            return updateWithSchemas(argumentType, resultType);
          }

          if (
            !insideJsx &&
            node.arguments.length >= 2 &&
            isFunctionLikeExpression(node.arguments[1]!)
          ) {
            const callback = node.arguments[1] as
              | ts.ArrowFunction
              | ts.FunctionExpression;
            const argumentType = context.checker.getTypeAtLocation(
              node.arguments[0]!,
            );
            const inferred = collectFunctionSchemaTypeNodes(
              callback,
              context.checker,
              argumentType,
            );

            if (inferred.argument && inferred.result) {
              return updateWithSchemas(inferred.argument, inferred.result);
            }
          }
        }

        if (callKind?.kind === "builder" && callKind.builderName === "lift") {
          const factory = transformation.factory;
          const updateWithSchemas = (
            argumentType: ts.TypeNode,
            resultType: ts.TypeNode,
          ): ts.Node => {
            ensureToSchemaImport();
            const updated = prependSchemaArguments(
              factory,
              node,
              argumentType,
              resultType,
            );
            return ts.visitEachChild(updated, visit, transformation);
          };

          if (node.typeArguments && node.typeArguments.length >= 2) {
            const [argumentType, resultType] = node.typeArguments;
            if (!argumentType || !resultType) {
              return ts.visitEachChild(node, visit, transformation);
            }

            return updateWithSchemas(argumentType, resultType);
          }

          if (
            node.arguments.length === 1 &&
            isFunctionLikeExpression(node.arguments[0]!)
          ) {
            const callback = node.arguments[0] as
              | ts.ArrowFunction
              | ts.FunctionExpression;
            const inferred = collectFunctionSchemaTypeNodes(
              callback,
              context.checker,
            );

            if (inferred.argument && inferred.result) {
              return updateWithSchemas(inferred.argument, inferred.result);
            }
          }
        }

        return ts.visitEachChild(node, visit, transformation);
      };

      return ts.visitEachChild(sourceFile, visit, transformation);
    },
  };
}
