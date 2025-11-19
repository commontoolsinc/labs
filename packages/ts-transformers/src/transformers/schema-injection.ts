import ts from "typescript";

import {
  detectCallKind,
  getExpressionText,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  isFunctionLikeExpression,
  typeToSchemaTypeNode,
} from "../ast/mod.ts";
import {
  TransformationContext,
  Transformer,
  type TypeRegistry,
} from "../core/mod.ts";

/**
 * Schema Injection Transformer - TypeRegistry Integration
 *
 * This transformer injects JSON schemas for CommonTools core functions (pattern, derive,
 * recipe, handler, lift) by analyzing TypeScript types and converting them to runtime schemas.
 *
 * ## TypeRegistry Integration (Unified Approach)
 *
 * All transformation paths now consistently check the TypeRegistry for closure-captured types.
 * The TypeRegistry is a WeakMap<TypeNode, Type> that enables coordination between transformers:
 *
 * 1. **ClosureTransformer** (runs first):
 *    - Creates synthetic TypeNodes for closure-captured variables
 *    - Registers TypeNode -> Type mappings in TypeRegistry
 *    - Enables type information preservation through AST transformations
 *
 * 2. **SchemaInjectionTransformer** (this file):
 *    - Checks TypeRegistry for existing Type mappings before inferring types
 *    - Preserves closure-captured type information from ClosureTransformer
 *    - Registers newly inferred types back into TypeRegistry
 *
 * 3. **SchemaGeneratorTransformer** (runs last):
 *    - Uses TypeRegistry to find Type information for synthetic TypeNodes
 *    - Generates accurate JSON schemas even for transformed/synthetic nodes
 *
 * ## Pattern-Specific Behavior
 *
 * - **Handler**: Checks TypeRegistry for type arguments, uses `unknown` fallback
 * - **Derive**: Checks TypeRegistry for type arguments, preserves shorthand property types
 * - **Pattern**: Checks TypeRegistry before inferring, registers inferred types
 * - **Recipe**: Checks TypeRegistry for type arguments
 * - **Lift**: Checks TypeRegistry for type arguments and inferred types
 *
 * ## Why This Matters
 *
 * Without TypeRegistry checking, closure-captured variables lose their type information
 * when ClosureTransformer creates synthetic AST nodes. By checking the registry first,
 * we preserve the original Type information and generate accurate schemas.
 *
 * Example: `const foo = { label: "test" }; pattern(() => ({ cell: foo }))`
 * - ClosureTransformer creates synthetic type for `foo`, registers it
 * - SchemaInjectionTransformer finds that type in TypeRegistry
 * - SchemaGeneratorTransformer uses it to create accurate schema for `foo`
 */

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

  // Check for underscore prefix FIRST - this convention overrides type inference
  // Underscore-prefixed parameters are intentionally unused and should be `never`
  if (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text.startsWith("_")
  ) {
    // Return never type directly - don't infer or use explicit type
    argumentNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  } else if (parameter?.type) {
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

/**
 * Creates a schema call and transfers TypeRegistry entry if it exists.
 * This is the unified pattern for all transformation paths to preserve
 * closure-captured type information from ClosureTransformer.
 *
 * @param context - Transformation context
 * @param typeNode - The TypeNode to create a schema for
 * @param typeRegistry - Optional TypeRegistry to check for existing types
 * @returns CallExpression for toSchema() with TypeRegistry entry transferred
 */
function createSchemaCallWithRegistryTransfer(
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  typeNode: ts.TypeNode,
  typeRegistry?: TypeRegistry,
): ts.CallExpression {
  const schemaCall = createToSchemaCall(context, typeNode);

  // Transfer TypeRegistry entry from source typeNode to schema call
  // This preserves type information for closure-captured variables
  if (typeRegistry) {
    const typeFromRegistry = typeRegistry.get(typeNode);
    if (typeFromRegistry) {
      typeRegistry.set(schemaCall, typeFromRegistry);
    }
  }

  return schemaCall;
}

/**
 * Gets type from TypeRegistry if available, otherwise uses fallback.
 * Used for inferred types that may have been created by ClosureTransformer.
 *
 * @param typeNode - The TypeNode to look up in registry
 * @param fallbackType - Type to use if not found in registry
 * @param typeRegistry - Optional TypeRegistry to check
 * @returns Type from registry or fallback type
 */
function getTypeFromRegistryOrFallback(
  typeNode: ts.TypeNode | undefined,
  fallbackType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
): ts.Type | undefined {
  if (typeNode && typeRegistry?.has(typeNode)) {
    return typeRegistry.get(typeNode);
  }
  return fallbackType;
}

/**
 * Determines the appropriate schema TypeNode for a function parameter based on
 * whether it exists and whether it has explicit type annotation.
 *
 * Rules:
 * - No parameter → never (schema: false)
 * - Parameter with _ prefix and no type → never (schema: false)
 * - Parameter with explicit type → use that type
 * - Parameter without type → unknown (schema: true)
 */
function getParameterSchemaType(
  factory: ts.NodeFactory,
  param: ts.ParameterDeclaration | undefined,
): ts.TypeNode {
  // No parameter at all → never
  if (!param) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type → use it
  if (param.type) {
    return param.type;
  }

  // Check if parameter name starts with _ (unused convention)
  if (ts.isIdentifier(param.name) && param.name.text.startsWith("_")) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Parameter exists without type → unknown
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

/**
 * Infer schema type for a specific parameter, respecting underscore-prefix convention
 * and attempting type inference before falling back to never/unknown.
 */
function inferParameterSchemaType(
  factory: ts.NodeFactory,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  paramIndex: number,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.TypeNode {
  const param = fn.parameters[paramIndex];

  // Check underscore prefix first
  if (param && ts.isIdentifier(param.name) && param.name.text.startsWith("_")) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type annotation - use it
  if (param?.type) {
    return param.type;
  }

  // Try to infer from signature
  if (param) {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (signature && signature.parameters.length > paramIndex) {
      const paramSymbol = signature.parameters[paramIndex];
      if (paramSymbol) {
        const paramType = checker.getTypeOfSymbol(paramSymbol);
        if (paramType && !isAnyOrUnknownType(paramType)) {
          const typeNode = typeToSchemaTypeNode(paramType, checker, sourceFile);
          if (typeNode) {
            return typeNode;
          }
        }
      }
    }
    // Inference failed - use unknown
    return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  // No parameter at all - use never
  return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
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
        const argsArray = Array.from(node.arguments);

        // Find the function argument - it's the last function-like expression in args
        // Can be: recipe(fn), recipe("name", fn), recipe(schema, fn), recipe(schema, schema, fn)
        let recipeFunction:
          | ts.ArrowFunction
          | ts.FunctionExpression
          | undefined;
        for (let i = argsArray.length - 1; i >= 0; i--) {
          const arg = argsArray[i];
          if (
            arg &&
            (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg))
          ) {
            recipeFunction = arg;
            break;
          }
        }

        if (!recipeFunction) {
          // No function found - skip transformation
          return ts.visitEachChild(node, visit, transformation);
        }

        // Determine input and result schema TypeNodes based on type arguments
        let inputTypeNode: ts.TypeNode;
        let inputType: ts.Type | undefined;
        let resultTypeNode: ts.TypeNode;
        let resultType: ts.Type | undefined;

        if (typeArgs && typeArgs.length >= 2) {
          // Case 1: Two or more type arguments → both schemas from type args
          // Examples: recipe<State, Result>(...), recipe<S, RS>(schema, schema, fn)
          inputTypeNode = typeArgs[0]!;
          resultTypeNode = typeArgs[1]!;

          // Check TypeRegistry for closure-captured types
          if (typeRegistry) {
            inputType = typeRegistry.get(inputTypeNode);
            resultType = typeRegistry.get(resultTypeNode);
          }
        } else if (typeArgs && typeArgs.length === 1) {
          // Case 2: One type argument → input from type arg, result inferred
          // Examples: recipe<State>("name", fn), recipe<State>(schema, fn)
          inputTypeNode = typeArgs[0]!;

          // Check TypeRegistry for input type
          if (typeRegistry) {
            inputType = typeRegistry.get(inputTypeNode);
          }

          // Infer result type from function
          const inferred = collectFunctionSchemaTypeNodes(
            recipeFunction,
            checker,
            sourceFile,
          );
          resultTypeNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          resultType = getTypeFromRegistryOrFallback(
            resultTypeNode,
            inferred.resultType,
            typeRegistry,
          );
        } else {
          // Case 3: No type arguments → infer both from function
          // Example: recipe(fn)
          const inputParam = recipeFunction.parameters[0];
          const inferred = collectFunctionSchemaTypeNodes(
            recipeFunction,
            checker,
            sourceFile,
          );

          inputTypeNode = inferred.argument ??
            getParameterSchemaType(factory, inputParam);
          inputType = getTypeFromRegistryOrFallback(
            inputTypeNode,
            inferred.argumentType,
            typeRegistry,
          );

          resultTypeNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          resultType = getTypeFromRegistryOrFallback(
            resultTypeNode,
            inferred.resultType,
            typeRegistry,
          );
        }

        // Create both schemas
        const toSchemaInput = createToSchemaCall(context, inputTypeNode);
        if (inputType && typeRegistry) {
          typeRegistry.set(toSchemaInput, inputType);
        }

        const toSchemaResult = createToSchemaCall(context, resultTypeNode);
        if (resultType && typeRegistry) {
          typeRegistry.set(toSchemaResult, resultType);
        }

        // Always use 2-schema API: [inputSchema, resultSchema, function]
        const newArgs = [toSchemaInput, toSchemaResult, recipeFunction];

        const updated = factory.createCallExpression(
          node.expression,
          undefined,
          newArgs,
        );

        return ts.visitEachChild(updated, visit, transformation);
      }

      if (callKind?.kind === "builder" && callKind.builderName === "pattern") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const argsArray = Array.from(node.arguments);

        // Get the function argument (should be the first and only argument)
        const patternFunction = argsArray[0];
        if (
          !patternFunction ||
          !(ts.isFunctionExpression(patternFunction) ||
            ts.isArrowFunction(patternFunction))
        ) {
          return ts.visitEachChild(node, visit, transformation);
        }

        // Handle explicit type arguments: pattern<Input, Output>(fn)
        if (typeArgs && typeArgs.length >= 2) {
          const [inputType, resultType] = typeArgs;

          if (inputType && resultType) {
            const argSchemaCall = createSchemaCallWithRegistryTransfer(
              context,
              inputType,
              typeRegistry,
            );
            const resSchemaCall = createSchemaCallWithRegistryTransfer(
              context,
              resultType,
              typeRegistry,
            );

            const updated = factory.createCallExpression(
              node.expression,
              undefined,
              [patternFunction, argSchemaCall, resSchemaCall],
            );

            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        // Use type arguments as a hint for inference
        const typeArgHints: ts.Type[] = [];
        if (typeArgs) {
          for (const typeArg of typeArgs) {
            const type = checker.getTypeFromTypeNode(typeArg);
            typeArgHints.push(type);
          }
        }

        // Collect inferred types from the function
        const inferred = collectFunctionSchemaTypeNodes(
          patternFunction,
          checker,
          sourceFile,
          typeArgHints[0], // Pass first type arg as fallback for parameter inference
        );

        // For argument: use inferred type or apply never/unknown refinement
        const argumentTypeNode = inferred.argument ??
          getParameterSchemaType(factory, patternFunction.parameters[0]);

        // For result: use inferred type or default to unknown
        const resultTypeNode = inferred.result ??
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        // Check TypeRegistry for existing types first (may be synthetic from ClosureTransformer)
        const argumentType = getTypeFromRegistryOrFallback(
          argumentTypeNode,
          inferred.argumentType,
          typeRegistry,
        );
        const resultType = getTypeFromRegistryOrFallback(
          resultTypeNode,
          inferred.resultType,
          typeRegistry,
        );

        // Always create both schemas
        const argSchemaCall = createToSchemaCall(context, argumentTypeNode);
        if (argumentType && typeRegistry) {
          typeRegistry.set(argSchemaCall, argumentType);
        }

        const resSchemaCall = createToSchemaCall(context, resultTypeNode);
        if (resultType && typeRegistry) {
          typeRegistry.set(resSchemaCall, resultType);
        }

        // Always transform with both schemas
        const updated = factory.createCallExpression(
          node.expression,
          undefined,
          [patternFunction, argSchemaCall, resSchemaCall],
        );

        return ts.visitEachChild(updated, visit, transformation);
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

          const toSchemaEvent = createSchemaCallWithRegistryTransfer(
            context,
            eventType,
            typeRegistry,
          );
          const toSchemaState = createSchemaCallWithRegistryTransfer(
            context,
            stateType,
            typeRegistry,
          );

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

            // Infer types from the handler function for both parameters
            const inferred = collectFunctionSchemaTypeNodes(
              handlerFn,
              checker,
              sourceFile,
            );

            // Event type: use inferred or fallback to never/unknown refinement
            const eventType = inferred.argument ??
              getParameterSchemaType(factory, handlerFn.parameters[0]);

            // State type: use helper for second parameter
            const stateType = inferParameterSchemaType(
              factory,
              handlerFn,
              1, // second parameter
              checker,
              sourceFile,
            );

            // Always transform - generate schemas regardless of parameter presence
            const toSchemaEvent = createSchemaCallWithRegistryTransfer(
              context,
              eventType,
              typeRegistry,
            );
            const toSchemaState = createSchemaCallWithRegistryTransfer(
              context,
              stateType,
              typeRegistry,
            );

            const updated = factory.createCallExpression(
              node.expression,
              undefined,
              [toSchemaEvent, toSchemaState, handlerFn],
            );

            return ts.visitEachChild(updated, visit, transformation);
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
          // Visit children to catch any recipe calls created by ClosureTransformer
          // inside the derive callback (e.g., from map transformations)
          return ts.visitEachChild(updated, visit, transformation);
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Check if ClosureTransformer registered Types for these TypeNodes
          // This preserves type information for shorthand properties with captured variables
          let argumentTypeValue: ts.Type | undefined;
          let resultTypeValue: ts.Type | undefined;

          if (typeRegistry) {
            if (typeRegistry.has(argumentType)) {
              argumentTypeValue = typeRegistry.get(argumentType);
            }
            if (typeRegistry.has(resultType)) {
              resultTypeValue = typeRegistry.get(resultType);
            }
          }

          return updateWithSchemas(
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
          );
        }

        if (
          node.arguments.length >= 2 &&
          isFunctionLikeExpression(node.arguments[1]!)
        ) {
          const firstArg = node.arguments[0]!;
          const callback = node.arguments[1] as
            | ts.ArrowFunction
            | ts.FunctionExpression;

          // Special case: detect empty object literal {} and generate specific schema
          let argNode: ts.TypeNode | undefined;
          let argType: ts.Type | undefined;

          if (
            ts.isObjectLiteralExpression(firstArg) &&
            firstArg.properties.length === 0
          ) {
            // Empty object literal - create a specific type for it
            // This should generate {type: "object", properties: {}, additionalProperties: false}
            argNode = factory.createTypeLiteralNode([]);
            // Don't set argType - let schema generator handle the synthetic node
          } else {
            // Normal case - infer from the argument type
            const argumentType = checker.getTypeAtLocation(firstArg);
            const inferred = collectFunctionSchemaTypeNodes(
              callback,
              checker,
              sourceFile,
              argumentType,
            );
            // Use inferred type or fallback to never/unknown refinement
            argNode = inferred.argument ??
              getParameterSchemaType(factory, callback.parameters[0]);
            argType = inferred.argumentType;
          }

          // Always infer return type
          const inferred = collectFunctionSchemaTypeNodes(
            callback,
            checker,
            sourceFile,
          );

          // Always transform - use unknown for missing types
          const finalArgNode = argNode ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          const resNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          return updateWithSchemas(
            finalArgNode,
            argType,
            resNode,
            inferred.resultType,
          );
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
          // Visit children to catch any recipe calls created by ClosureTransformer
          // inside the derive callback (e.g., from map transformations)
          return ts.visitEachChild(updated, visit, transformation);
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Check TypeRegistry for closure-captured types (like Handler does)
          // This allows SchemaGeneratorTransformer to find Types for synthetic TypeNodes
          // created by ClosureTransformer
          let argumentTypeValue: ts.Type | undefined;
          let resultTypeValue: ts.Type | undefined;

          if (typeRegistry) {
            argumentTypeValue = typeRegistry.get(argumentType);
            resultTypeValue = typeRegistry.get(resultType);
          }

          return updateWithSchemas(
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
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

          // For argument: use inferred type or apply never/unknown refinement
          const argNode = inferred.argument ??
            getParameterSchemaType(factory, callback.parameters[0]);

          // For result: use inferred type or default to unknown
          const resNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

          // Check TypeRegistry for inferred types (may be synthetic from ClosureTransformer)
          const argType = getTypeFromRegistryOrFallback(
            argNode,
            inferred.argumentType,
            typeRegistry,
          );
          const resType = getTypeFromRegistryOrFallback(
            resNode,
            inferred.resultType,
            typeRegistry,
          );

          // Always transform with both schemas
          return updateWithSchemas(
            argNode,
            argType,
            resNode,
            resType,
          );
        }
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitEachChild(sourceFile, visit, transformation);
  }
}
