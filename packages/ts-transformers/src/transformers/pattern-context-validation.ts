/**
 * Pattern Context Validation Transformer
 *
 * Validates code within pattern contexts (pattern, .map on cells/opaques)
 * to catch common reactive programming mistakes.
 *
 * Rules:
 * - Reading from opaques is NOT allowed in:
 *   - pattern body (top-level reactive context)
 *   - map functions bound to opaques/cells (mapWithPattern)
 *
 * - Reading from opaques IS allowed in:
 *   - computed()
 *   - action()
 *   - derive()
 *   - lift()
 *   - handler()
 *   - JSX expressions and other lowerable expression sites
 * - Local values created by computed()/derive() inside the current
 *   computed()/derive() callback remain reactive and cannot be used as plain
 *   values until a nested computed()/derive() consumes them.
 *
 * - Function creation is NOT allowed in pattern context (must be at module scope)
 * - lift() and handler() must be defined at module scope, not inside patterns
 *
 * Errors reported:
 * - Property access used in computation: ERROR (must wrap in computed())
 * - Optional chaining:
 *   - optional property/element access is allowed in supported lowerable
 *     expression sites
 *   - optional calls and non-lowerable optional access still error
 * - Calling .get() on cells: ERROR (must wrap in computed())
 * - Function creation in pattern context: ERROR (move to module scope)
 * - lift()/handler() inside pattern: ERROR (move to module scope)
 * - Local computed()/derive() aliases used as plain values in the same
 *   callback: ERROR (use a nested computed()/derive())
 */
import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  classifyArrayMethodCallSite,
  detectCallKind,
  detectDirectBuilderCall,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
  isStandaloneFunctionDefinition,
} from "../ast/mod.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import {
  collectLocalOpaqueRootSymbols,
  isOpaqueSourceExpression,
  isTopmostMemberAccess,
} from "./opaque-roots.ts";
import {
  classifyRestrictedReactiveComputation,
  classifyUnsupportedExpressionSiteCallRoot,
  findLowerableExpressionSite,
} from "./expression-site-policy.ts";

const EMPTY_OPAQUE_ROOTS = new Set<string>();

export class PatternContextValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;
    const analyze = context.getDataFlowAnalyzer();

    const visit = (node: ts.Node): ts.Node => {
      // Skip JSX element containers; expression-level handling is shared.
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

        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          const boundarySemantics = getCallbackBoundarySemantics(
            node,
            checker,
            context,
          );
          if (boundarySemantics.establishesLocalReactiveAliasScope) {
            this.validateLocalReactiveAliasUsage(node, context);
          }

          this.validateSupportedPatternStatements(node, context, checker);
        }
      }

      // Check for optional chaining in reactive context
      // Note: isInRestrictedReactiveContext returns false for JSX expressions,
      // so this won't flag optional chaining inside JSX like <div>{user?.name}</div>
      if (
        (
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        ) &&
        node.questionDotToken
      ) {
        const optionalCallTargetHandledByCallRootPolicy =
          !!node.questionDotToken &&
          !!node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          classifyUnsupportedExpressionSiteCallRoot(
              node.parent,
              context,
              analyze,
            ) === "optional-call";
        if (
          !optionalCallTargetHandledByCallRootPolicy &&
          isInRestrictedReactiveContext(node, checker, context) &&
          !findLowerableExpressionSite(node, context, analyze)
        ) {
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

        const unsupportedCallRoot = classifyUnsupportedExpressionSiteCallRoot(
          node,
          context,
          analyze,
        );
        if (unsupportedCallRoot === "optional-call") {
          context.reportDiagnostic({
            severity: "error",
            type: "pattern-context:optional-chaining",
            message:
              `Optional chaining '?.' is not allowed in reactive context. ` +
              `Use ifElse() or wrap in computed() for conditional access.`,
            node,
          });
        } else if (unsupportedCallRoot === "restricted-get-call") {
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
        this.validateComputationExpression(node, context, analyze);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
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
    analyze: ReturnType<TransformationContext["getDataFlowAnalyzer"]>,
  ): void {
    const expression = node as ts.Expression;
    const decision = classifyRestrictedReactiveComputation(
      expression,
      context,
      analyze,
    );
    if (decision.kind !== "requires-computed") {
      return;
    }

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

  private validateLocalReactiveAliasUsage(
    func: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
  ): void {
    const localOpaqueRootSymbols = collectLocalOpaqueRootSymbols(
      func.body,
      context,
    );
    if (localOpaqueRootSymbols.size === 0) {
      return;
    }

    const diagnosticsSeen = new Set<number>();

    const findProblematicUse = (
      expression: ts.Expression,
    ): ts.Expression | undefined => {
      let culprit: ts.Expression | undefined;

      const visit = (node: ts.Node): void => {
        if (culprit) return;
        if (node !== expression && ts.isFunctionLike(node)) return;

        if (
          ts.isCallExpression(node) &&
          isOpaqueSourceExpression(
            node,
            EMPTY_OPAQUE_ROOTS,
            localOpaqueRootSymbols,
            context,
          )
        ) {
          culprit = node;
          return;
        }

        if (
          (ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
          isTopmostMemberAccess(node) &&
          isOpaqueSourceExpression(
            node,
            EMPTY_OPAQUE_ROOTS,
            localOpaqueRootSymbols,
            context,
          )
        ) {
          culprit = node;
          return;
        }

        if (
          ts.isIdentifier(node) &&
          !this.isMemberAccessBase(node) &&
          isOpaqueSourceExpression(
            node,
            EMPTY_OPAQUE_ROOTS,
            localOpaqueRootSymbols,
            context,
          )
        ) {
          culprit = node;
          return;
        }

        ts.forEachChild(node, visit);
      };

      visit(expression);
      return culprit;
    };

    const report = (culprit: ts.Expression): void => {
      const key = culprit.getStart(context.sourceFile);
      if (diagnosticsSeen.has(key)) return;
      diagnosticsSeen.add(key);

      context.reportDiagnostic({
        severity: "error",
        type: "compute-context:local-reactive-use",
        message: `Reactive value '${culprit.getText()}' is created in this ` +
          `computed()/derive() callback and cannot be used as a plain value ` +
          `here. Move this use into a nested computed(() => ...) or ` +
          `derive(() => ...) callback.`,
        node: culprit,
      });
    };

    const checkExpression = (expression: ts.Expression | undefined): void => {
      if (!expression) return;
      const culprit = findProblematicUse(expression);
      if (culprit) {
        report(culprit);
      }
    };

    const visitBody = (node: ts.Node): void => {
      if (node !== func.body && ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isIfStatement(node)) {
        checkExpression(node.expression);
      } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        checkExpression(node.expression);
      } else if (ts.isForStatement(node)) {
        checkExpression(node.condition);
      } else if (ts.isSwitchStatement(node)) {
        checkExpression(node.expression);
      } else if (this.isComputationExpression(node)) {
        checkExpression(node as ts.Expression);
      }

      ts.forEachChild(node, visitBody);
    };

    visitBody(func.body);
  }

  private isMemberAccessBase(node: ts.Identifier): boolean {
    const parent = node.parent;
    return !!parent &&
      (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      );
  }

  /**
   * Validates statement-level constructs in pattern-owned callback bodies.
   * For now, the supported subset is intentionally narrow:
   * - a single terminal return statement
   * - no let declarations
   * - no reassignment
   * - no loops
   * - no var declarations
   *
   * This applies to any callback body that still classifies as pattern context
   * at validation time, which intentionally includes pattern-owned array method
   * callbacks while excluding compute-owned wrappers like computed()/derive().
   */
  private validateSupportedPatternStatements(
    func: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    if (!ts.isBlock(func.body)) return;

    const boundarySemantics = getCallbackBoundarySemantics(
      func,
      checker,
      context,
    );
    const bodyContext = context.getReactiveContext(func.body);
    if (
      !boundarySemantics.supportsPatternOwnedStatements ||
      bodyContext.kind !== "pattern"
    ) {
      return;
    }

    const lastStatement = func.body.statements.at(-1);
    const diagnosticsSeen = new Set<number>();
    const reportOnce = (
      node: ts.Node,
      type:
        | "pattern-context:assignment"
        | "pattern-context:early-return"
        | "pattern-context:let-declaration"
        | "pattern-context:loop"
        | "pattern-context:var-declaration",
      message: string,
    ) => {
      const start = node.getStart(context.sourceFile);
      if (diagnosticsSeen.has(start)) return;
      diagnosticsSeen.add(start);
      context.reportDiagnostic({
        severity: "error",
        type,
        message,
        node,
      });
    };

    const visit = (node: ts.Node): void => {
      if (node !== func.body && ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isReturnStatement(node)) {
        const isTerminalReturn = node.parent === func.body &&
          node === lastStatement;
        if (!isTerminalReturn) {
          reportOnce(
            node,
            "pattern-context:early-return",
            `Early returns are not supported in pattern bodies. ` +
              `Use a single terminal return statement and move conditional branching into expressions or helper wrappers.`,
          );
        }
        return;
      }

      if (ts.isVariableDeclarationList(node)) {
        if ((node.flags & ts.NodeFlags.Let) !== 0) {
          reportOnce(
            node,
            "pattern-context:let-declaration",
            `let declarations are not supported in pattern-owned callback bodies. ` +
              `Use const, or move mutable logic into computed(), derive(), or a helper.`,
          );
        } else if (
          (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
        ) {
          reportOnce(
            node,
            "pattern-context:var-declaration",
            `var declarations are not supported in pattern-owned callback bodies. ` +
              `Use const, or move mutable logic into computed(), derive(), or a module-scope helper.`,
          );
        }
      }

      if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        reportOnce(
          node,
          "pattern-context:loop",
          `Loop statements are not supported in pattern-owned callback bodies. ` +
            `Use array methods, helper-owned expressions, or move imperative iteration into computed(), derive(), or a helper.`,
        );
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        reportOnce(
          node,
          "pattern-context:assignment",
          `Reassignment is not supported in pattern-owned callback bodies. ` +
            `Use straight-line data construction, or move mutable logic into computed(), derive(), or a helper.`,
        );
      }

      ts.forEachChild(node, visit);
    };

    visit(func.body);
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
    // Skip if inside safe wrapper callback (computed, action, derive, lift, handler)
    if (isInsideSafeCallbackWrapper(node, checker, context)) return;

    const boundarySemantics = !ts.isFunctionDeclaration(node)
      ? getCallbackBoundarySemantics(node, checker, context)
      : undefined;

    if (boundarySemantics?.allowsRestrictedContextFunctionCallback) {
      return;
    }

    // Only error if inside restricted context (pattern/render)
    if (!isInsideRestrictedContext(node, checker, context)) return;

    if (this.isInsideJsx(node)) {
      if (boundarySemantics?.decision.kind === "supported") {
        return;
      }

      if (
        boundarySemantics?.decision.kind === "unsupported" &&
        boundarySemantics.decision.boundaryDiagnostic === "callback-container"
      ) {
        context.reportDiagnostic({
          severity: "error",
          type: "pattern-context:callback-container",
          message:
            `Callbacks passed to unsupported containers in pattern-facing JSX are not supported. ` +
            `Use a supported array method/value call, an event handler, or move this work into computed(() => ...), derive(...), or a helper.`,
          node,
        });
      }
      return;
    }

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
   * Validates that lift() and handler() are at module scope, not inside patterns.
   * These builders create reusable functions and should be defined outside the pattern body.
   */
  private validateBuilderPlacement(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    const builderCall = detectDirectBuilderCall(node, checker);
    if (
      !builderCall ||
      (builderCall.builderName !== "lift" &&
        builderCall.builderName !== "handler")
    ) {
      return;
    }

    const builderName = builderCall.builderName;

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
    if (!ts.isFunctionDeclaration(func)) {
      const boundarySemantics = getCallbackBoundarySemantics(
        func,
        checker,
        context,
      );
      if (boundarySemantics.isPatternToolCallback) {
        return;
      }
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
        const arrayMethodCallSite = classifyArrayMethodCallSite(node, checker);

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

          if (arrayMethodCallSite?.ownership === "reactive") {
            context.reportDiagnostic({
              severity: "error",
              type: "standalone-function:reactive-operation",
              message:
                `.${arrayMethodCallSite.family}() on reactive types is not allowed inside standalone functions. ` +
                `Standalone functions cannot capture reactive closures. ` +
                `Move the .${arrayMethodCallSite.family}() call to the pattern body, or use patternTool() to enable automatic closure capture. ` +
                `If this is an explicit Cell/Writable value and eager ${arrayMethodCallSite.family}ing is acceptable, use <cell>.get().${arrayMethodCallSite.family}(...).`,
              node,
            });
            return;
          }
        }
      }

      ts.forEachChild(node, visitBody);
    };

    if (func.body) {
      visitBody(func.body);
    }
  }
}
