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
import { getCellKind } from "@commontools/schema-generator/cell-brand";
import { isReactiveOriginCall } from "../ast/call-kind.ts";

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
   * Check if an expression is reactive via structural analysis (not type-based).
   * This handles cases where OpaqueRef<T> = T and the type loses its brand.
   *
   * Important: this only infers reactivity from values produced by reactive
   * calls, not from callback parameters to builder definitions. Builder
   * callbacks keep their declared input semantics; only the values produced by
   * invoking the resulting factories should be treated as structurally reactive.
   */
  private isReactiveExpression(
    expr: ts.Expression,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      if (!symbol) return false;

      for (const decl of symbol.declarations ?? []) {
        // Check if it's a variable initialized from a reactive call
        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          if (this.isReactiveInitializer(decl.initializer, checker)) {
            return true;
          }
        }

        // Check binding elements (destructured variables)
        if (ts.isBindingElement(decl)) {
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

    // Property access on reactive expression
    if (ts.isPropertyAccessExpression(expr)) {
      return this.isReactiveExpression(expr.expression, checker);
    }

    return false;
  }

  /**
   * Check if an initializer expression comes from a reactive call.
   */
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
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
        continue;
      }
      break;
    }
    return ts.isCallExpression(current) &&
      isReactiveOriginCall(current, checker);
  }
}
