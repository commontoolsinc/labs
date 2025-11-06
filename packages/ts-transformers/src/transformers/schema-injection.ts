import ts from "typescript";

import {
  detectCallKind,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  typeToSchemaTypeNode,
} from "../ast/mod.ts";
import {
  TransformationContext,
  Transformer,
  type TypeRegistry,
} from "../core/mod.ts";

function isFunctionLikeExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function collectFunctionSchemaTypeNodes(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  fallbackArgType?: ts.Type,
): {
  argument?: ts.TypeNode;
  argumentType?: ts.Type; // Store the Type for registry
  result?: ts.TypeNode;
  resultType?: ts.Type; // Store the Type for registry
} {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return {};

  // 1. Get parameter TypeNode (prefer original if it exists)
  const parameter = fn.parameters.length > 0 ? fn.parameters[0] : undefined;
  let argumentNode: ts.TypeNode | undefined;
  let argumentType: ts.Type | undefined;

  if (parameter?.type) {
    // Use original TypeNode from source - preserves all type information!
    argumentNode = parameter.type;
    // Also get the Type for registry (in case it's needed)
    argumentType = checker.getTypeFromTypeNode(parameter.type);
  } else {
    // Need to infer - get type and convert to TypeNode
    const paramType = inferParameterType(
      parameter,
      signature,
      checker,
      fallbackArgType,
    );
    if (paramType && !isAnyOrUnknownType(paramType)) {
      argumentType = paramType; // Store for registry
      argumentNode = typeToSchemaTypeNode(paramType, checker, sourceFile);
    }
    // If inference failed, leave argumentNode undefined - we'll use unknown below
  }

  // 2. Get return type TypeNode
  let resultNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;

  if (fn.type) {
    // Explicit return type annotation - use it directly!
    resultNode = fn.type;
    // Also get the Type for registry (in case it's needed)
    resultType = checker.getTypeFromTypeNode(fn.type);
  } else {
    // Need to infer return type
    const returnType = inferReturnType(fn, signature, checker);
    if (returnType && !isAnyOrUnknownType(returnType)) {
      resultType = returnType; // Store for registry
      resultNode = typeToSchemaTypeNode(returnType, checker, sourceFile);
    }
    // If inference failed, leave resultNode undefined - we'll use unknown below
  }

  // 3. If we couldn't infer a type, we can't transform at all
  // Both types are required for derive/lift to work
  if (!argumentNode && !resultNode) {
    return {}; // No types could be determined
  }

  // Build result object with only defined properties
  const result: {
    argument?: ts.TypeNode;
    argumentType?: ts.Type;
    result?: ts.TypeNode;
    resultType?: ts.Type;
  } = {};

  if (argumentNode) {
    result.argument = argumentNode;
    if (argumentType) result.argumentType = argumentType;
  }
  if (resultNode) {
    result.result = resultNode;
    if (resultType) result.resultType = resultType;
  }

  return result;
}

function createToSchemaCall(
  { ctHelpers, factory }: Pick<
    TransformationContext,
    "ctHelpers" | "factory"
  >,
  typeNode: ts.TypeNode,
): ts.CallExpression {
  const expr = ctHelpers.getHelperExpr("toSchema");
  return factory.createCallExpression(
    expr,
    [typeNode],
    [],
  );
}

function prependSchemaArguments(
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  node: ts.CallExpression,
  argumentTypeNode: ts.TypeNode,
  argumentType: ts.Type | undefined,
  resultTypeNode: ts.TypeNode,
  resultType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
  checker?: ts.TypeChecker,
): ts.CallExpression {
  const argSchemaCall = createToSchemaCall(
    context,
    argumentTypeNode,
  );
  const resSchemaCall = createToSchemaCall(
    context,
    resultTypeNode,
  );

  // Register Types if they were inferred (not from original source)
  if (typeRegistry && checker) {
    if (argumentType) {
      typeRegistry.set(argSchemaCall, argumentType);
    }
    if (resultType) {
      typeRegistry.set(resSchemaCall, resultType);
    }
  }

  return context.factory.createCallExpression(
    node.expression,
    undefined,
    [argSchemaCall, resSchemaCall, ...node.arguments],
  );
}

export class SchemaInjectionTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, tsContext: transformation, checker } = context;
    const typeRegistry = context.options.typeRegistry;

    const visit = (node: ts.Node): ts.Node => {
      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visit, transformation);
      }

      const callKind = detectCallKind(node, checker);

      if (callKind?.kind === "builder" && callKind.builderName === "recipe") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;

        if (typeArgs && typeArgs.length >= 1) {
          const schemaArgs = typeArgs.map((typeArg) => typeArg).map((
            typeArg,
          ) => createToSchemaCall(context, typeArg));

          const argsArray = Array.from(node.arguments);
          let remainingArgs = argsArray;
          if (
            argsArray.length > 0 &&
            argsArray[0] && ts.isStringLiteral(argsArray[0])
          ) {
            remainingArgs = argsArray.slice(1);
          }

          const updated = factory.createCallExpression(
            node.expression,
            undefined,
            [...schemaArgs, ...remainingArgs],
          );

          return ts.visitEachChild(updated, visit, transformation);
        }

        // Handle single-parameter recipe() calls without type arguments
        // Only transform if the function parameter has a type annotation
        const argsArray = Array.from(node.arguments);
        let recipeFunction: ts.Expression | undefined;
        let recipeName: ts.StringLiteral | undefined;

        if (argsArray.length === 1) {
          // Single argument - must be the function
          recipeFunction = argsArray[0];
        } else if (
          argsArray.length === 2 && argsArray[0] &&
          ts.isStringLiteral(argsArray[0])
        ) {
          // Two arguments with first being a string - second is the function
          recipeName = argsArray[0];
          recipeFunction = argsArray[1];
        }

        if (
          recipeFunction &&
          (ts.isFunctionExpression(recipeFunction) ||
            ts.isArrowFunction(recipeFunction))
        ) {
          const recipeFn = recipeFunction;
          if (recipeFn.parameters.length >= 1) {
            const inputParam = recipeFn.parameters[0];

            // Only transform if there's an explicit type annotation
            if (inputParam?.type) {
              const toSchemaInput = createToSchemaCall(
                context,
                inputParam.type,
              );

              // Preserve the name argument if it was provided
              const newArgs = recipeName
                ? [recipeName, toSchemaInput, recipeFn]
                : [toSchemaInput, recipeFn];

              const updated = factory.createCallExpression(
                node.expression,
                undefined,
                newArgs,
              );

              return ts.visitEachChild(updated, visit, transformation);
            }
          }
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
          const toSchemaEvent = createToSchemaCall(context, eventType);
          const toSchemaState = createToSchemaCall(context, stateType);

          // Register Types in TypeRegistry (if they exist from ClosureTransformer)
          // This allows SchemaGeneratorTransformer to find the Types for synthetic TypeNodes
          // If no Type was registered by ClosureTransformer, don't try to create one -
          // the synthetic TypeNode will be handled by generateSchemaFromSyntheticTypeNode
          if (typeRegistry) {
            const eventTypeFromRegistry = typeRegistry.get(eventType);
            const stateTypeFromRegistry = typeRegistry.get(stateType);

            // Only register if we have a Type from ClosureTransformer
            if (eventTypeFromRegistry) {
              typeRegistry.set(toSchemaEvent, eventTypeFromRegistry);
            }

            if (stateTypeFromRegistry) {
              typeRegistry.set(toSchemaState, stateTypeFromRegistry);
            }
          }

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
                const toSchemaEvent = createToSchemaCall(context, eventType);
                const toSchemaState = createToSchemaCall(context, stateType);

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
        const updateWithSchemas = (
          argumentType: ts.TypeNode,
          argumentTypeValue: ts.Type | undefined,
          resultType: ts.TypeNode,
          resultTypeValue: ts.Type | undefined,
        ): ts.Node => {
          const updated = prependSchemaArguments(
            context,
            node,
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
            typeRegistry,
            checker,
          );
          // Don't visit children - we've already transformed this node
          return updated;
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return updateWithSchemas(
            argumentType,
            undefined,
            resultType,
            undefined,
          );
        }

        if (
          node.arguments.length >= 2 &&
          isFunctionLikeExpression(node.arguments[1]!)
        ) {
          const callback = node.arguments[1] as
            | ts.ArrowFunction
            | ts.FunctionExpression;
          const argumentType = checker.getTypeAtLocation(
            node.arguments[0]!,
          );
          const inferred = collectFunctionSchemaTypeNodes(
            callback,
            checker,
            sourceFile,
            argumentType,
          );

          // Transform if we got at least one type, filling in unknown for the other
          if (inferred.argument || inferred.result) {
            const argNode = inferred.argument ??
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            const resNode = inferred.result ??
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            return updateWithSchemas(
              argNode,
              inferred.argumentType,
              resNode,
              inferred.resultType,
            );
          }
        }
      }

      if (callKind?.kind === "builder" && callKind.builderName === "lift") {
        const factory = transformation.factory;
        const updateWithSchemas = (
          argumentType: ts.TypeNode,
          argumentTypeValue: ts.Type | undefined,
          resultType: ts.TypeNode,
          resultTypeValue: ts.Type | undefined,
        ): ts.Node => {
          const updated = prependSchemaArguments(
            context,
            node,
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
            typeRegistry,
            checker,
          );
          // Don't visit children - we've already transformed this node
          return updated;
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return updateWithSchemas(
            argumentType,
            undefined,
            resultType,
            undefined,
          );
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
            checker,
            sourceFile,
          );

          // Transform if we got at least one type, filling in unknown for the other
          if (inferred.argument || inferred.result) {
            const argNode = inferred.argument ??
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            const resNode = inferred.result ??
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            return updateWithSchemas(
              argNode,
              inferred.argumentType,
              resNode,
              inferred.resultType,
            );
          }
        }
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitEachChild(sourceFile, visit, transformation);
  }
}
