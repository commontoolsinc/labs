import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import type { OpaqueRefRule } from "./jsx-expression.ts";
import { detectCallKind } from "../call-kind.ts";
import { getCommonToolsImportIdentifier } from "../../core/common-tools.ts";

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

      const getToSchemaIdentifier = (): ts.Identifier => {
        const existing = getCommonToolsImportIdentifier(
          sourceFile,
          transformation.factory,
          "toSchema",
        );
        if (existing) {
          return existing;
        }

        return transformation.factory.createIdentifier("toSchema");
      };

      const visit = (node: ts.Node): ts.Node => {
        if (!ts.isCallExpression(node)) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const factory = transformation.factory;
        const callKind = detectCallKind(node, context.checker);

        const isToSchemaCall = (expr: ts.Expression): boolean => {
          if (!ts.isCallExpression(expr)) return false;
          const inner = expr.expression;
          return ts.isIdentifier(inner) && inner.text === "toSchema";
        };

        const getTypeArgumentFromToSchema = (
          expr: ts.Expression,
        ): ts.TypeNode | undefined => {
          if (!ts.isCallExpression(expr)) return undefined;
          if (!isToSchemaCall(expr)) return undefined;
          return expr.typeArguments && expr.typeArguments.length > 0
            ? expr.typeArguments[0]
            : undefined;
        };

        const createToSchemaCall = (
          typeNode: ts.TypeNode,
        ): ts.CallExpression => {
          ensureToSchemaImport();
          return factory.createCallExpression(
            getToSchemaIdentifier(),
            [typeNode],
            [],
          );
        };

        if (callKind?.kind === "builder" && callKind.builderName === "recipe") {
          const existingTypeArgs = node.typeArguments;
          const alreadyInjected = node.arguments.length >= 1 &&
            isToSchemaCall(node.arguments[0]!);

          if (alreadyInjected) {
            if (!existingTypeArgs || existingTypeArgs.length === 0) {
              const inferredInputType = getTypeArgumentFromToSchema(
                node.arguments[0]!,
              );
              const inferredOutputType = node.arguments.length >= 2
                ? getTypeArgumentFromToSchema(node.arguments[1]!)
                : undefined;
              if (inferredInputType) {
                const updated = factory.createCallExpression(
                  node.expression,
                  inferredOutputType
                    ? [inferredInputType, inferredOutputType]
                    : [inferredInputType],
                  [...node.arguments],
                );
                return ts.visitEachChild(updated, visit, transformation);
              }
            }
            return ts.visitEachChild(node, visit, transformation);
          }

          if (existingTypeArgs && existingTypeArgs.length >= 1) {
            const inputType = existingTypeArgs[0]!;
            const outputType = existingTypeArgs.length >= 2
              ? existingTypeArgs[1]
              : undefined;

            const schemaArgs: ts.Expression[] = [
              createToSchemaCall(inputType),
            ];
            if (outputType) {
              schemaArgs.push(createToSchemaCall(outputType));
            }

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
              existingTypeArgs,
              [...schemaArgs, ...remainingArgs],
            );

            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        if (callKind?.kind === "builder" && callKind.builderName === "lift") {
          const existingTypeArgs = node.typeArguments;
          const alreadyInjected = node.arguments.length >= 2 &&
            isToSchemaCall(node.arguments[0]!) &&
            isToSchemaCall(node.arguments[1]!);

          if (alreadyInjected) {
            if (!existingTypeArgs || existingTypeArgs.length < 2) {
              const inferredInputType = getTypeArgumentFromToSchema(
                node.arguments[0]!,
              );
              const inferredOutputType = getTypeArgumentFromToSchema(
                node.arguments[1]!,
              );
              if (inferredInputType && inferredOutputType) {
                const updated = factory.createCallExpression(
                  node.expression,
                  [inferredInputType, inferredOutputType],
                  [...node.arguments],
                );
                return ts.visitEachChild(updated, visit, transformation);
              }
            }
            return ts.visitEachChild(node, visit, transformation);
          }

          if (existingTypeArgs && existingTypeArgs.length >= 2) {
            const inputType = existingTypeArgs[0]!;
            const outputType = existingTypeArgs[1]!;

            const updated = factory.createCallExpression(
              node.expression,
              existingTypeArgs,
              [
                createToSchemaCall(inputType),
                createToSchemaCall(outputType),
                ...node.arguments,
              ],
            );

            return ts.visitEachChild(updated, visit, transformation);
          }
        }

        if (
          callKind?.kind === "builder" && callKind.builderName === "handler"
        ) {
          const existingTypeArgs = node.typeArguments;
          const alreadyInjected = node.arguments.length >= 2 &&
            isToSchemaCall(node.arguments[0]!) &&
            isToSchemaCall(node.arguments[1]!);

          if (alreadyInjected) {
            if (!existingTypeArgs || existingTypeArgs.length < 2) {
              const inferredEventType = getTypeArgumentFromToSchema(
                node.arguments[0]!,
              );
              const inferredStateType = getTypeArgumentFromToSchema(
                node.arguments[1]!,
              );
              if (inferredEventType && inferredStateType) {
                const updated = factory.createCallExpression(
                  node.expression,
                  [inferredEventType, inferredStateType],
                  [...node.arguments],
                );
                return ts.visitEachChild(updated, visit, transformation);
              }
            }
            return ts.visitEachChild(node, visit, transformation);
          }

          if (existingTypeArgs && existingTypeArgs.length >= 2) {
            const eventType = existingTypeArgs[0]!;
            const stateType = existingTypeArgs[1]!;

            const updated = factory.createCallExpression(
              node.expression,
              existingTypeArgs,
              [
                createToSchemaCall(eventType),
                createToSchemaCall(stateType),
                ...node.arguments,
              ],
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
                  const toSchemaEvent = createToSchemaCall(eventType);
                  const toSchemaState = createToSchemaCall(stateType);

                  const updated = factory.createCallExpression(
                    node.expression,
                    [eventType, stateType],
                    [toSchemaEvent, toSchemaState, handlerFn],
                  );

                  return ts.visitEachChild(updated, visit, transformation);
                }
              }
            }
          }
        }

        return ts.visitEachChild(node, visit, transformation);
      };

      return ts.visitEachChild(sourceFile, visit, transformation);
    },
  };
}
