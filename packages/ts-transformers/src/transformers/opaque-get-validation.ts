/**
 * OpaqueRef .get() Validation Transformer
 *
 * Validates that .get() is not called on OpaqueRef types.
 * OpaqueRef values (from pattern inputs, computed(), lift()) can be accessed
 * directly without .get(). Only Writable<T> (Cell<T>) requires .get().
 *
 * This transformer provides a clear, actionable error message before TypeScript
 * produces its complex type error about the missing .get() method.
 */
import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { getCellKind } from "@commonfabric/schema-generator/cell-brand";
import { detectCallKind, isReactiveOriginCall } from "../ast/call-kind.ts";

export class OpaqueGetValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      // Check for .get() calls
      if (ts.isCallExpression(node)) {
        this.validateGetCall(node, context, checker);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  /**
   * Checks if a call expression is a .get() call on an OpaqueRef type
   * and reports a helpful error if so.
   */
  private validateGetCall(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    const expr = node.expression;

    // Check if this is a .get() call with no arguments
    if (
      !ts.isPropertyAccessExpression(expr) ||
      expr.name.text !== "get" ||
      node.arguments.length !== 0
    ) {
      return;
    }

    // Get the type of the receiver (the expression before .get())
    const receiverExpr = expr.expression;
    let receiverType: ts.Type;
    try {
      receiverType = checker.getTypeAtLocation(receiverExpr);
    } catch {
      // Can't resolve type, skip validation
      return;
    }

    // Check if the receiver is an "opaque" cell kind (OpaqueRef/OpaqueCell)
    // These types don't have .get() - values are accessed directly
    const cellKind = getCellKind(receiverType, checker);

    // Cell/Writable/Stream types have .get() — only opaque types don't
    if (cellKind === "cell" || cellKind === "stream") {
      return;
    }

    // Determine if the receiver is a reactive value (type-based or structural)
    const isReactive = cellKind === "opaque" ||
      this.isReactiveExpression(receiverExpr, checker);

    if (isReactive) {
      // Get the receiver text for the error message
      const receiverText = receiverExpr.getText();
      const callText = `${receiverText}.get()`;

      context.reportDiagnostic({
        severity: "error",
        type: "opaque-get:invalid-call",
        message: `Calling .get() on '${receiverText}' is not allowed. ` +
          `This is a reactive value that can be accessed directly - change '${callText}' to '${receiverText}'. ` +
          `Reactive values passed to pattern (except Writable<T> and Stream<T>) and results from computed() and lift() ` +
          `don't need .get() to read them. Only Writable<T> requires .get() to read values.`,
        node,
      });
    }
  }

  /**
   * Structural fallback for cases where OpaqueRef<T> = T and the brand is gone.
   *
   * We intentionally only infer reactivity from:
   * - pattern/render callback inputs
   * - local variables initialized from reactive origin calls
   *
   * Lift/handler/action/derive callback parameters keep their declared cell
   * semantics and must not be inferred as opaque from structure alone.
   */
  private isReactiveExpression(
    expr: ts.Expression,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      if (!symbol) return false;

      for (const decl of symbol.declarations ?? []) {
        if (
          ts.isParameter(decl) && this.isPatternCallbackParameter(decl, checker)
        ) {
          return true;
        }

        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          if (this.isReactiveInitializer(decl.initializer, checker)) {
            return true;
          }
        }

        if (ts.isBindingElement(decl)) {
          const parameter = this.getOwningParameter(decl);
          if (
            parameter && this.isPatternCallbackParameter(parameter, checker)
          ) {
            return true;
          }

          let parent: ts.Node = decl;
          while (
            ts.isBindingElement(parent) ||
            ts.isObjectBindingPattern(parent) ||
            ts.isArrayBindingPattern(parent)
          ) {
            parent = parent.parent;
          }
          if (ts.isVariableDeclaration(parent) && parent.initializer) {
            if (this.isReactiveInitializer(parent.initializer, checker)) {
              return true;
            }
          }
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)
    ) {
      return this.isReactiveExpression(expr.expression, checker);
    }

    return false;
  }

  private getOwningParameter(
    node: ts.BindingElement,
  ): ts.ParameterDeclaration | undefined {
    let current: ts.Node = node;
    while (
      ts.isBindingElement(current) ||
      ts.isObjectBindingPattern(current) ||
      ts.isArrayBindingPattern(current)
    ) {
      current = current.parent;
    }
    return ts.isParameter(current) ? current : undefined;
  }

  private isPatternCallbackParameter(
    param: ts.ParameterDeclaration,
    checker: ts.TypeChecker,
  ): boolean {
    let functionNode: ts.Node | undefined = param.parent;
    while (functionNode && !ts.isFunctionLike(functionNode)) {
      functionNode = functionNode.parent;
    }
    if (!functionNode) return false;

    let candidate: ts.Node | undefined = functionNode.parent;
    while (candidate && !ts.isCallExpression(candidate)) {
      candidate = candidate.parent;
    }
    if (!candidate) return false;

    const callKind = detectCallKind(candidate as ts.CallExpression, checker);
    return callKind?.kind === "builder" &&
      (callKind.builderName === "pattern" || callKind.builderName === "render");
  }

  private isReactiveInitializer(
    expr: ts.Expression,
    checker: ts.TypeChecker,
  ): boolean {
    let current: ts.Expression = expr;
    while (true) {
      if (
        ts.isNonNullExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      break;
    }

    return ts.isCallExpression(current) &&
      isReactiveOriginCall(current, checker);
  }
}
