import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import type { OpaqueRefRule } from "./jsx-expression.ts";
import { detectCallKind } from "../call-kind.ts";
import { getCommonToolsImportIdentifier } from "../../core/common-tools.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";

export function createSchemaInjectionRule(
  recordHelperReference: (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => void,
): OpaqueRefRule {
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

        const identifier = transformation.factory.createIdentifier("toSchema");
        recordHelperReference("toSchema", identifier);
        return identifier;
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
            const schemaArgs = typeArgs.map((typeArg) => typeArg).map((typeArg) =>
              factory.createCallExpression(
                getToSchemaIdentifier(),
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
              getToSchemaIdentifier(),
              [eventType],
              [],
            );
            const toSchemaState = factory.createCallExpression(
              getToSchemaIdentifier(),
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
                    getToSchemaIdentifier(),
                    [eventType],
                    [],
                  );
                  const toSchemaState = factory.createCallExpression(
                    getToSchemaIdentifier(),
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
