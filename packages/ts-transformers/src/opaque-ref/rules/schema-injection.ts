import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import type { OpaqueRefRule } from "./jsx-expression.ts";
import { detectCallKind } from "../call-kind.ts";

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

        return ts.visitEachChild(node, visit, transformation);
      };

      return ts.visitEachChild(sourceFile, visit, transformation);
    },
  };
}
