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

    if (cellKind === "opaque") {
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
}
