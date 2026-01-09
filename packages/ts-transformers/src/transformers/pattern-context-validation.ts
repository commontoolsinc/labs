/**
 * Pattern Context Validation Transformer
 *
 * Validates code within pattern contexts (recipe, pattern, .map on cells/opaques)
 * to catch common reactive programming mistakes.
 *
 * Rules:
 * - Reading from opaques is NOT allowed in:
 *   - recipe/pattern body (top-level reactive context)
 *   - map functions bound to opaques/cells (mapWithPattern)
 *
 * - Reading from opaques IS allowed in:
 *   - computed()
 *   - action()
 *   - derive()
 *   - lift()
 *   - handler()
 *   - JSX expressions (handled by OpaqueRefJSXTransformer)
 *
 * Errors reported:
 * - Property access used in computation: ERROR (must wrap in computed())
 * - Optional chaining (?.): ERROR (not allowed in reactive context)
 * - Calling .get() on cells: ERROR (must wrap in computed())
 */
import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  createDataFlowAnalyzer,
  isInRestrictedReactiveContext,
} from "../ast/mod.ts";

export class PatternContextValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;
    const analyze = createDataFlowAnalyzer(checker);

    const visit = (node: ts.Node): ts.Node => {
      // Skip JSX - OpaqueRefJSXTransformer handles those
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      // Check for optional chaining in reactive context
      // Note: isInRestrictedReactiveContext returns false for JSX expressions
      // (they are handled by OpaqueRefJSXTransformer), so this won't flag
      // optional chaining inside JSX like <div>{user?.name}</div>
      if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
        if (isInRestrictedReactiveContext(node, checker)) {
          context.reportDiagnostic({
            severity: "error",
            type: "pattern-context:optional-chaining",
            message:
              `Optional chaining '?.' is not allowed in reactive context. ` +
              `Use ifElse() or wrap in computed() for conditional access.`,
            node,
          });
        }
      }

      // Check for .get() calls in reactive context
      if (ts.isCallExpression(node)) {
        if (
          this.isGetCall(node) &&
          isInRestrictedReactiveContext(node, checker)
        ) {
          context.reportDiagnostic({
            severity: "error",
            type: "pattern-context:get-call",
            message:
              `Calling .get() on a cell is not allowed in reactive context. ` +
              `Wrap the computation in computed(() => myCell.get()) instead.`,
            node,
          });
        }
      }

      // Check for property access used in computation (not just pass-through)
      // This applies to expressions in binary operators, conditionals, etc.
      if (this.isComputationExpression(node)) {
        this.validateComputationExpression(node, context, checker, analyze);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  /**
   * Checks if a call expression is a .get() call
   */
  private isGetCall(node: ts.CallExpression): boolean {
    const expr = node.expression;
    return (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "get" &&
      node.arguments.length === 0
    );
  }

  /**
   * Checks if this node is an expression that performs computation
   * (binary expression, unary expression, conditional, etc.)
   */
  private isComputationExpression(node: ts.Node): boolean {
    return (
      ts.isBinaryExpression(node) ||
      ts.isPrefixUnaryExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      ts.isConditionalExpression(node)
    );
  }

  /**
   * Validates that a computation expression doesn't improperly use reactive values
   */
  private validateComputationExpression(
    node: ts.Node,
    context: TransformationContext,
    checker: ts.TypeChecker,
    analyze: ReturnType<typeof createDataFlowAnalyzer>,
  ): void {
    // Skip if not in restricted reactive context
    if (!isInRestrictedReactiveContext(node, checker)) {
      return;
    }

    // Skip if inside JSX
    if (this.isInsideJsx(node)) {
      return;
    }

    // Analyze the expression for reactive dependencies
    const expression = node as ts.Expression;
    const analysis = analyze(expression);

    // If this computation contains reactive refs, it should be wrapped in computed()
    if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
      // Find the specific property access that's causing the issue
      const problemAccess = this.findProblematicAccess(node);
      const accessText = problemAccess
        ? `'${problemAccess.getText()}'`
        : "property access";

      context.reportDiagnostic({
        severity: "error",
        type: "pattern-context:computation",
        message:
          `Property access ${accessText} used in computation is not allowed in reactive context. ` +
          `Wrap the computation in computed(() => ...) instead.`,
        node,
      });
    }
  }

  /**
   * Checks if a node is inside a JSX element
   */
  private isInsideJsx(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isJsxElement(current) ||
        ts.isJsxSelfClosingElement(current) ||
        ts.isJsxExpression(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Finds the first property access expression in the computation
   */
  private findProblematicAccess(
    node: ts.Node,
  ): ts.PropertyAccessExpression | undefined {
    let result: ts.PropertyAccessExpression | undefined;

    const find = (n: ts.Node): void => {
      if (result) return;
      if (ts.isPropertyAccessExpression(n)) {
        result = n;
        return;
      }
      ts.forEachChild(n, find);
    };

    find(node);
    return result;
  }
}
