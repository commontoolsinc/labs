import ts from "typescript";
import { getPatternBuilderCallbackArgument } from "../ast/mod.ts";
import { TransformationContext } from "../core/mod.ts";
import {
  addBindingTargetSymbols,
  isOpaqueSourceExpression,
} from "./opaque-roots.ts";

export interface PatternCallbackPreScanResult {
  arrayMethodPatternCallNodes: Set<ts.Node>;
  nonReactiveCapturesByMapPattern: Map<ts.Node, Set<string>>;
}

export function collectPatternCallbackPreScan(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): PatternCallbackPreScanResult {
  const arrayMethodPatternCallNodes = new Set<ts.Node>();
  const nonReactiveCapturesByMapPattern = new Map<ts.Node, Set<string>>();

  interface ScopeInfo {
    opaqueNames: Set<string>;
    opaqueSymbols: Set<ts.Symbol>;
  }

  const scopeStack: ScopeInfo[] = [];

  const collectBindingNames = (
    name: ts.BindingName,
    names: Set<string>,
  ): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        collectBindingNames(el.name, names);
      }
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (!ts.isOmittedExpression(el)) {
          collectBindingNames(el.name, names);
        }
      }
    }
  };

  const collectOpaqueBindings = (
    body: ts.ConciseBody,
    scope: ScopeInfo,
  ): void => {
    if (!ts.isBlock(body)) return;
    for (const stmt of body.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (
          isOpaqueSourceExpression(
            decl.initializer,
            scope.opaqueNames,
            scope.opaqueSymbols,
            context,
          )
        ) {
          collectBindingNames(decl.name, scope.opaqueNames);
          addBindingTargetSymbols(
            decl.name,
            scope.opaqueSymbols,
            context.checker,
          );
        }
      }
    }
  };

  const preScan = (node: ts.Node): void => {
    let pushed = false;
    if (ts.isCallExpression(node)) {
      const cb = getPatternBuilderCallbackArgument(node, context.checker);
      if (cb) {
        const opaqueNames = new Set<string>();
        const opaqueSymbols = new Set<ts.Symbol>();
        const firstParam = cb.parameters[0];
        if (firstParam) {
          collectBindingNames(firstParam.name, opaqueNames);
          addBindingTargetSymbols(
            firstParam.name,
            opaqueSymbols,
            context.checker,
          );
        }
        const scope: ScopeInfo = { opaqueNames, opaqueSymbols };
        collectOpaqueBindings(cb.body, scope);
        scopeStack.push(scope);
        pushed = true;
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "mapWithPattern" &&
      node.arguments[0] &&
      ts.isCallExpression(node.arguments[0])
    ) {
      const innerPattern = node.arguments[0];
      arrayMethodPatternCallNodes.add(innerPattern);

      const scope = scopeStack.at(-1);
      if (scope && node.arguments[1]) {
        const capturesArg = node.arguments[1];
        if (ts.isObjectLiteralExpression(capturesArg)) {
          const nonReactive = new Set<string>();
          for (const prop of capturesArg.properties) {
            let originalName: string | undefined;
            let captureName: string | undefined;
            if (ts.isShorthandPropertyAssignment(prop)) {
              originalName = prop.name.text;
              captureName = prop.name.text;
            } else if (
              ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)
            ) {
              captureName = prop.name.text;
              originalName = ts.isIdentifier(prop.initializer)
                ? prop.initializer.text
                : prop.name.text;
            }
            if (
              originalName && captureName &&
              !scope.opaqueNames.has(originalName)
            ) {
              nonReactive.add(captureName);
            }
          }
          if (nonReactive.size > 0) {
            nonReactiveCapturesByMapPattern.set(innerPattern, nonReactive);
          }
        }
      }
    }

    ts.forEachChild(node, preScan);

    if (pushed) scopeStack.pop();
  };

  preScan(sourceFile);

  return {
    arrayMethodPatternCallNodes,
    nonReactiveCapturesByMapPattern,
  };
}
