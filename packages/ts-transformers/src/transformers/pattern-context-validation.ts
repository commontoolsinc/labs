/**
 * Pattern Context Validation Transformer
 *
 * Validates code within pattern contexts (pattern, .map on cells/opaques)
 * to catch common reactive programming mistakes.
 *
 * Rules:
 * - Function creation is NOT allowed in pattern context (must be at module scope)
 * - lift() and handler() must be defined at module scope, not inside patterns
 * - Calling .get() on cells in reactive context: ERROR (must wrap in computed())
 * - Standalone functions cannot use computed()/derive()/.map() on reactive types
 */
import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  detectCallKind,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
  isStandaloneFunctionDefinition,
} from "../ast/mod.ts";

export class PatternContextValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

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

        // Check for reactive operations in standalone functions
        if (isStandaloneFunctionDefinition(node)) {
          this.validateStandaloneFunction(node, context, checker);
        }
      }

      // Check for .get() calls and lift/handler placement in reactive context
      if (ts.isCallExpression(node)) {
        // Check for lift/handler inside pattern
        this.validateBuilderPlacement(node, context, checker);

        // Check for .get() calls
        if (
          this.isGetCall(node) &&
          isInRestrictedReactiveContext(node, checker, context)
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
    if (isInsideSafeCallbackWrapper(node, checker, context)) return;

    // Skip if this function IS a callback to a safe wrapper
    // e.g., computed(() => ...), action(() => ...), derive(() => ...)
    if (this.isSafeWrapperCallback(node, checker)) return;

    // Only error if inside restricted context (pattern/render)
    if (!isInsideRestrictedContext(node, checker, context)) return;

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

    // patternTool handles closure capture for its callback
    if (callKind.kind === "pattern-tool") return true;

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
    if (!isInsideRestrictedContext(node, checker, context)) return;

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
          `Move this ${builderName}() call outside the pattern and add explicit type parameters. ` +
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
   * Validates that standalone functions don't use reactive operations like
   * computed(), derive(), or .map() on CellLike types.
   *
   * Standalone functions cannot have their closures captured automatically.
   * Users should either:
   * - Move the reactive operation out of the standalone function
   * - Use patternTool() which handles closure capture automatically
   *
   * Exception: Functions passed inline to patternTool() are handled by the
   * patternTool transformer and don't need validation here.
   *
   * Limitation: This check is purely syntactic — it only recognizes functions
   * passed *inline* as the first argument to patternTool(). If a function is
   * defined separately and then passed to patternTool(), e.g.:
   *
   *   const myFn = ({ query }) => { return computed(...) };
   *   const tool = patternTool(myFn);
   *
   * ...the validator will still flag myFn, because it can't trace dataflow to
   * see that it ends up as a patternTool argument. The workaround is to inline
   * the function into the patternTool() call.
   */
  private validateStandaloneFunction(
    func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Skip if this function is passed to patternTool()
    if (this.isPatternToolArgument(func, checker)) {
      return;
    }

    // Walk the function body looking for reactive operations
    const visitBody = (node: ts.Node): void => {
      // Skip nested function definitions - they have their own scope
      if (
        node !== func &&
        (ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node))
      ) {
        return;
      }

      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);

        if (callKind) {
          // Check for computed() calls
          if (
            callKind.kind === "builder" &&
            callKind.builderName === "computed"
          ) {
            context.reportDiagnostic({
              severity: "error",
              type: "standalone-function:reactive-operation",
              message:
                `computed() is not allowed inside standalone functions. ` +
                `Standalone functions cannot capture reactive closures. ` +
                `Move the computed() call to the pattern body, or use patternTool() to enable automatic closure capture.`,
              node,
            });
            return;
          }

          // Check for derive() calls
          if (callKind.kind === "derive") {
            context.reportDiagnostic({
              severity: "error",
              type: "standalone-function:reactive-operation",
              message: `derive() is not allowed inside standalone functions. ` +
                `Standalone functions cannot capture reactive closures. ` +
                `Move the derive() call to the pattern body, or use patternTool() to enable automatic closure capture.`,
              node,
            });
            return;
          }

          // Check for .map() on CellLike types
          if (callKind.kind === "array-map") {
            // Check if this is a map on a CellLike type (not a plain array)
            if (ts.isPropertyAccessExpression(node.expression)) {
              const receiverType = checker.getTypeAtLocation(
                node.expression.expression,
              );
              if (this.isCellLikeOrOpaqueRefType(receiverType, checker)) {
                context.reportDiagnostic({
                  severity: "error",
                  type: "standalone-function:reactive-operation",
                  message:
                    `.map() on reactive types is not allowed inside standalone functions. ` +
                    `Standalone functions cannot capture reactive closures. ` +
                    `Move the .map() call to the pattern body, or use patternTool() to enable automatic closure capture. ` +
                    `If this is an explicit Cell/Writable value and eager mapping is acceptable, use <cell>.get().map(...).`,
                  node,
                });
                return;
              }
            }
          }
        }
      }

      ts.forEachChild(node, visitBody);
    };

    if (func.body) {
      visitBody(func.body);
    }
  }

  /**
   * Checks if a function is passed directly as an argument to patternTool().
   * If so, the patternTool transformer will handle closure capture.
   */
  private isPatternToolArgument(
    func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    checker: ts.TypeChecker,
  ): boolean {
    // Function declarations can't be passed as arguments
    if (ts.isFunctionDeclaration(func)) return false;

    const parent = func.parent;
    if (!parent || !ts.isCallExpression(parent)) return false;

    // Check if this function is the first argument
    if (parent.arguments[0] !== func) return false;

    // Use detectCallKind for consistent call detection
    const callKind = detectCallKind(parent, checker);
    return callKind?.kind === "pattern-tool";
  }

  /**
   * Checks if a type is a CellLike or OpaqueRef type that would require
   * reactive handling in .map() calls inside standalone functions.
   *
   * Uses string-based type-name matching rather than brand-based detection
   * so this works even after OpaqueRef debranding.
   */
  private isCellLikeOrOpaqueRefType(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): boolean {
    const typeStr = checker.typeToString(type);
    const cellLikePatterns = [
      "Cell<",
      "OpaqueCell<",
      "Writable<",
      "Stream<",
      "OpaqueRef<",
      "OpaqueRefMethods<",
    ];

    return cellLikePatterns.some((pattern) => typeStr.includes(pattern));
  }
}
