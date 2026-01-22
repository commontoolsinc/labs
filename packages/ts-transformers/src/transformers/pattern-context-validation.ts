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
 * - Function creation is NOT allowed in pattern context (must be at module scope)
 * - lift() and handler() must be defined at module scope, not inside patterns
 *
 * Errors reported:
 * - Property access used in computation: ERROR (must wrap in computed())
 * - Optional chaining (?.): ERROR (not allowed in reactive context)
 * - Calling .get() on cells: ERROR (must wrap in computed())
 * - Function creation in pattern context: ERROR (move to module scope)
 * - lift()/handler() inside pattern: ERROR (move to module scope)
 * - .map() on fallback expression (x ?? [] or x || []): ERROR (use direct property access)
 */
import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  createDataFlowAnalyzer,
  detectCallKind,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
} from "../ast/mod.ts";
import { isOpaqueRefType } from "./opaque-ref/opaque-ref.ts";

export class PatternContextValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;
    const analyze = createDataFlowAnalyzer(checker);

    const visit = (node: ts.Node): ts.Node => {
      // Skip JSX - OpaqueRefJSXTransformer handles those
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      // Check for function creation in pattern context
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node)
      ) {
        this.validateFunctionCreation(node, context, checker);
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

      // Check for .get() calls and lift/handler placement in reactive context
      if (ts.isCallExpression(node)) {
        // Check for lift/handler inside pattern
        this.validateBuilderPlacement(node, context, checker);

        // Check for .map() on fallback expressions (x ?? [] or x || [])
        this.validateMapOnFallbackExpression(node, context, checker);

        // Check for .get() calls
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

  /**
   * Validates that functions are not created directly in pattern context.
   * Functions inside safe wrappers (computed, action, derive, lift, handler)
   * and inside JSX expressions are allowed since they get transformed.
   */
  private validateFunctionCreation(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Skip if inside JSX (including map callbacks, event handlers)
    if (this.isInsideJsx(node)) return;

    // Skip if inside safe wrapper callback (computed, action, derive, lift, handler)
    if (isInsideSafeCallbackWrapper(node, checker)) return;

    // Skip if this function IS a callback to a safe wrapper
    // e.g., computed(() => ...), action(() => ...), derive(() => ...)
    if (this.isSafeWrapperCallback(node, checker)) return;

    // Only error if inside restricted context (recipe/pattern/render)
    if (!isInsideRestrictedContext(node, checker)) return;

    context.reportDiagnostic({
      severity: "error",
      type: "pattern-context:function-creation",
      message: `Function creation is not allowed in pattern context. ` +
        `Move this function to module scope and add explicit type parameters. ` +
        `Note: callbacks inside computed(), action(), and .map() are allowed.`,
      node,
    });
  }

  /**
   * Checks if a function is being passed directly as a callback to a safe wrapper
   * (computed, action, derive, lift, handler) or to a .map() call on cells/opaques.
   */
  private isSafeWrapperCallback(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    checker: ts.TypeChecker,
  ): boolean {
    // Function declarations can't be callbacks
    if (ts.isFunctionDeclaration(node)) return false;

    const parent = node.parent;
    if (!parent || !ts.isCallExpression(parent)) return false;

    // Check if this function is an argument to the call
    if (!parent.arguments.includes(node)) return false;

    const callKind = detectCallKind(parent, checker);
    if (!callKind) return false;

    // derive is a safe wrapper
    if (callKind.kind === "derive") return true;

    // array-map on cells/opaques is transformed, so callbacks are allowed
    if (callKind.kind === "array-map") return true;

    // Check builder-based safe wrappers (computed, action, lift, handler)
    // Note: derive is handled separately above (it has its own kind, not "builder")
    if (callKind.kind === "builder") {
      const safeBuilders = new Set([
        "computed",
        "action",
        "lift",
        "handler",
      ]);
      return safeBuilders.has(callKind.builderName);
    }

    return false;
  }

  /**
   * Validates that lift() and handler() are at module scope, not inside patterns.
   * These builders create reusable functions and should be defined outside the pattern body.
   */
  private validateBuilderPlacement(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Only check direct calls to lift/handler, not calls to functions returned by them
    // detectCallKind can incorrectly match calls to lift-returned functions
    if (
      !this.isDirectBuilderCall(node, "lift") &&
      !this.isDirectBuilderCall(node, "handler")
    ) {
      return;
    }

    const builderName = this.isDirectBuilderCall(node, "lift")
      ? "lift"
      : "handler";

    // Only error if inside restricted context
    if (!isInsideRestrictedContext(node, checker)) return;

    // Check if lift() is immediately invoked: lift(fn)(args)
    // In this case, suggest computed() instead
    // We verify node.parent.expression === node to ensure lift() is the callee,
    // not just an argument (e.g., someFunction(lift(fn)) should not match)
    const isImmediatelyInvoked = ts.isCallExpression(node.parent) &&
      node.parent.expression === node;

    if (builderName === "lift" && isImmediatelyInvoked) {
      context.reportDiagnostic({
        severity: "error",
        type: "pattern-context:builder-placement",
        message:
          `lift() should not be defined and immediately invoked inside a pattern. ` +
          `Use computed(() => ...) instead for inline computations.`,
        node,
      });
    } else {
      context.reportDiagnostic({
        severity: "error",
        type: "pattern-context:builder-placement",
        message:
          `${builderName}() should be defined at module scope, not inside a pattern. ` +
          `Move this ${builderName}() call outside the pattern/recipe and add explicit type parameters. ` +
          `Note: computed(), action(), and .map() callbacks are allowed inside patterns.`,
        node,
      });
    }
  }

  /**
   * Checks if a call expression is a direct call to a builder (lift, handler, etc.)
   * by checking if the callee is literally the builder name.
   */
  private isDirectBuilderCall(
    node: ts.CallExpression,
    builderName: string,
  ): boolean {
    const callee = node.expression;

    // Direct call: lift(...) or handler(...)
    if (ts.isIdentifier(callee) && callee.text === builderName) {
      return true;
    }

    // Property access call: something.lift(...) or something.handler(...)
    if (
      ts.isPropertyAccessExpression(callee) && callee.name.text === builderName
    ) {
      return true;
    }

    return false;
  }

  /**
   * Validates that .map() is not called on a fallback expression like (x ?? []) or (x || [])
   * where one side is reactive (OpaqueRef) and the other is not.
   *
   * This pattern fails at runtime because the transformer can't properly detect that
   * the result needs mapWithPattern transformation.
   */
  private validateMapOnFallbackExpression(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text !== "map") return;

    let target: ts.Expression = node.expression.expression;

    // Unwrap parentheses
    while (ts.isParenthesizedExpression(target)) {
      target = target.expression;
    }

    // Check if target is (x ?? y) or (x || y)
    if (!ts.isBinaryExpression(target)) return;

    const op = target.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.QuestionQuestionToken &&
      op !== ts.SyntaxKind.BarBarToken
    ) {
      return;
    }

    // Check if left side is OpaqueRef and right side is not
    const leftType = checker.getTypeAtLocation(target.left);
    const rightType = checker.getTypeAtLocation(target.right);

    const leftIsOpaque = isOpaqueRefType(leftType, checker);
    const rightIsOpaque = isOpaqueRefType(rightType, checker);

    if (leftIsOpaque && !rightIsOpaque) {
      context.reportDiagnostic({
        severity: "error",
        type: "pattern-context:map-on-fallback",
        message:
          `'.map()' on fallback expression with mixed reactive/non-reactive types is not supported. ` +
          `Use direct property access: 'x.map(...)' rather than '(x ?? fallback).map(...)'`,
        node,
      });
    }
  }
}
