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
import { detectCallKind } from "../ast/call-kind.ts";

const REACTIVE_CALL_KINDS = new Set([
  "builder",
  "derive",
  "wish",
  "cell-factory",
  "cell-for",
  "generate-object",
]);

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
   */
  private isReactiveExpression(
    expr: ts.Expression,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      if (!symbol) return false;

      for (const decl of symbol.declarations ?? []) {
        // Check if it's a pattern callback parameter or destructured from one
        if (this.isPatternParameter(decl)) {
          return true;
        }

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
          if (this.isPatternParameter(parent)) {
            return true;
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
   * Check if a node is a parameter of a pattern/builder callback.
   */
  private isPatternParameter(node: ts.Node): boolean {
    if (!ts.isParameter(node)) return false;

    const fn = node.parent;
    if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) {
      return false;
    }

    const call = fn.parent;
    if (!call || !ts.isCallExpression(call)) return false;

    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      return callee.text === "pattern" || callee.text === "handler" ||
        callee.text === "lift" || callee.text === "computed" ||
        callee.text === "render";
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      return name === "pattern" || name === "handler" ||
        name === "lift" || name === "computed" || name === "render";
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
    if (ts.isCallExpression(current)) {
      const callKind = detectCallKind(current, checker);
      if (callKind && REACTIVE_CALL_KINDS.has(callKind.kind)) {
        return true;
      }
    }
    return false;
  }
}
