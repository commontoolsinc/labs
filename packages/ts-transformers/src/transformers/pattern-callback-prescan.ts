import ts from "typescript";
import { isFunctionLikeExpression } from "../ast/mod.ts";
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
  isPatternBuilderCall: (
    call: ts.CallExpression,
    checker: ts.TypeChecker,
  ) => boolean,
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
          ts.isIdentifier(decl.name) &&
          isOpaqueSourceExpression(
            decl.initializer,
            scope.opaqueNames,
            scope.opaqueSymbols,
            context,
          )
        ) {
          scope.opaqueNames.add(decl.name.text);
          const sym = context.checker.getSymbolAtLocation(decl.name);
          if (sym) scope.opaqueSymbols.add(sym);
        }
      }
    }
  };

  const preScan = (node: ts.Node): void => {
    let pushed = false;
    if (
      ts.isCallExpression(node) &&
      isPatternBuilderCall(node, context.checker)
    ) {
      const cb = node.arguments[0];
      if (cb && isFunctionLikeExpression(cb)) {
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
