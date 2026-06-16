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
 *   - lift()
 *   - handler()
 *   - JSX expressions and other lowerable expression sites
 * - Local values created by computed()/lift() inside the current
 *   computed()/lift() callback remain reactive and cannot be used as plain
 *   values until a nested computed()/lift() consumes them.
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
 * - Local computed()/lift() aliases used as plain values in the same
 *   callback: ERROR (use a nested computed()/lift())
 */
import ts from "typescript";
import { COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES } from "../core/commonfabric-runtime-registry.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  classifyArrayMethodCallSite,
  detectCallKind,
  detectDirectBuilderCall,
  getNodeText,
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
import {
  isDeclaredWithinFunction,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import type {
  CallbackBoundarySemantics,
  SupportedCallbackBoundaryKind,
} from "../policy/callback-boundary.ts";

const EMPTY_OPAQUE_ROOTS = new Set<string>();
const SES_SELF_CONTAINED_CALLBACK_BOUNDARIES = new Set<
  SupportedCallbackBoundaryKind
>([
  "event-handler",
  "reactive-array-method",
  "pattern-tool",
  "pattern-builder",
  "render-builder",
  "lift-applied",
  "computed-builder",
  "action-builder",
  "lift-builder",
  "handler-builder",
  // NB: "sqlite-row-label-rule" is deliberately NOT here — table() evaluates
  // the rule callback eagerly at pattern build into a serialized AST; it is
  // never extracted to run later, so closure capture is harmless.
]);

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

          this.validateCallbackSelfContainment(
            node,
            boundarySemantics,
            context,
            checker,
          );

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

        // patternTool's first argument must be a pattern() (CT-1655)
        this.validatePatternToolFirstArgument(node, context, checker);

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
        } else if (
          unsupportedCallRoot === "restricted-get-call" &&
          !findLowerableExpressionSite(node, context, analyze)
        ) {
          // A bare terminal `.get()` (no enclosing lowerable expression site)
          // can't be auto-wrapped, so it stays an error. But a `.get()` that
          // feeds a computation at a lowerable site (variable initializer, JSX,
          // return, …) is auto-wrapped into a lift by the rewriter — so don't
          // reject it here.
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
      ? `'${getNodeText(problemAccess)}'`
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
        message:
          `Reactive value '${getNodeText(culprit)}' is created in this ` +
          `computed()/lift() callback and cannot be used as a plain value ` +
          `here. Move this use into a nested computed(() => ...) or ` +
          `module-scope lift() callback.`,
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
   * callbacks while excluding compute-owned wrappers like computed()/lift().
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
              `Use const, or move mutable logic into computed(), module-scope lift(), or a helper.`,
          );
        } else if (
          (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
        ) {
          reportOnce(
            node,
            "pattern-context:var-declaration",
            `var declarations are not supported in pattern-owned callback bodies. ` +
              `Use const, or move mutable logic into computed(), module-scope lift(), or a module-scope helper.`,
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
            `Use array methods, helper-owned expressions, or move imperative iteration into computed(), module-scope lift(), or a helper.`,
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
            `Use straight-line data construction, or move mutable logic into computed(), module-scope lift(), or a helper.`,
        );
      }

      ts.forEachChild(node, visit);
    };

    visit(func.body);
  }

  /**
   * Validates that functions are not created directly in pattern context.
   * Functions inside safe wrappers (computed, action, lift, handler)
   * and inside JSX expressions are allowed since they get transformed.
   */
  private validateFunctionCreation(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Skip if inside safe wrapper callback (computed, action, lift, handler)
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
            `Use a supported array method/value call, an event handler, or move this work into computed(() => ...), module-scope lift(), or a helper.`,
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
   * Validates that `patternTool(...)`'s first argument is a `pattern(...)`, not a
   * bare callback (CT-1655). Passing a function directly used to be auto-wrapped
   * (`pattern(fn)`) by the runtime and auto-captured by a transformer strategy;
   * both were removed in favor of an explicit, addressable pattern. Authors now
   * wrap the callback themselves: `patternTool(pattern(fn), extraParams?)`.
   */
  private validatePatternToolFirstArgument(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    if (detectCallKind(node, checker)?.kind !== "pattern-tool") {
      return;
    }
    const firstArg = node.arguments[0];
    if (
      !firstArg ||
      !(ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))
    ) {
      return;
    }
    context.reportDiagnostic({
      severity: "error",
      type: "pattern-context:patterntool-requires-pattern",
      message:
        `patternTool()'s first argument must be a pattern(), not a bare callback. ` +
        `Wrap the callback in pattern(): patternTool(pattern(fn), extraParams?). ` +
        `Module-scoped reactive values the callback reads are captured by the ` +
        `pattern automatically; per-instance values go in extraParams.`,
      node: firstArg,
    });
  }

  private validateCallbackSelfContainment(
    func: ts.ArrowFunction | ts.FunctionExpression,
    boundarySemantics: CallbackBoundarySemantics,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    const decision = boundarySemantics.decision;
    if (
      decision.kind !== "supported" ||
      !SES_SELF_CONTAINED_CALLBACK_BOUNDARIES.has(decision.boundaryKind)
    ) {
      return;
    }

    const diagnosticsSeen = new Set<string>();

    const report = (node: ts.Identifier): void => {
      if (diagnosticsSeen.has(node.text)) return;
      diagnosticsSeen.add(node.text);
      context.reportDiagnostic({
        severity: "error",
        type: "ses-callback:callable-capture",
        message:
          `Callback passed to ${decision.boundaryKind} captures callable ` +
          `'${node.text}' from an enclosing function scope. SES callback ` +
          `implementations must be self-contained; move callable helpers to ` +
          `module scope, or pass serializable data through explicit inputs/state.`,
        node,
      });
    };

    const visit = (node: ts.Node): void => {
      if (node !== func && ts.isFunctionLike(node)) {
        return;
      }

      if (ts.isIdentifier(node) && !this.shouldIgnoreReferenceSite(node)) {
        const symbol = this.getReferenceSymbol(node, checker);
        const declarations = (symbol?.getDeclarations() ?? []).filter((decl) =>
          !ts.isShorthandPropertyAssignment(decl)
        );
        if (
          declarations.length > 0 &&
          declarations.some((decl) =>
            this.isEnclosingFunctionScopedDeclaration(decl, func)
          ) &&
          this.isCallableReference(node, declarations, checker)
        ) {
          report(node);
        }
      }

      ts.forEachChild(node, visit);
    };

    for (const parameter of func.parameters) {
      if (parameter.initializer) {
        visit(parameter.initializer);
      }
    }
    visit(func.body);
  }

  /**
   * Validates that standalone functions don't use reactive operations like
   * computed(), lift(), or .map() on CellLike types.
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
          if (
            callKind.kind === "builder" &&
            COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES.has(
              callKind.builderName,
            )
          ) {
            context.reportDiagnostic({
              severity: "error",
              type: "standalone-function:reactive-operation",
              message:
                `${callKind.builderName}() is not allowed inside standalone functions. ` +
                `Common Fabric builders must be authored in an allowed context ` +
                `so their callbacks can be self-contained for SES sandboxing. ` +
                `Move the ${callKind.builderName}() call to module scope, a pattern-owned context, or use patternTool() when closure capture is required.`,
              node,
            });
            return;
          }

          // Check for lift-applied calls (the lowered form of computed() and
          // other reactive lifted-function computations).
          if (callKind.kind === "lift-applied") {
            context.reportDiagnostic({
              severity: "error",
              type: "standalone-function:reactive-operation",
              message:
                `Reactive computations are not allowed inside standalone functions. ` +
                `Standalone functions cannot capture reactive closures. ` +
                `Move the computed() call to the pattern body, or use patternTool() to enable automatic closure capture.`,
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

  private shouldIgnoreReferenceSite(node: ts.Identifier): boolean {
    if (!node.parent || this.isInsideTypeNode(node)) {
      return true;
    }

    if (
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node
    ) {
      return true;
    }

    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) {
      return true;
    }

    if (ts.isBindingElement(node.parent)) {
      return true;
    }

    if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
      return true;
    }

    if (ts.isParameter(node.parent) && node.parent.name === node) {
      return true;
    }

    if (
      ts.isFunctionDeclaration(node.parent) &&
      node.parent.name === node
    ) {
      return true;
    }

    if (
      ts.isFunctionExpression(node.parent) &&
      node.parent.name === node
    ) {
      return true;
    }

    if (
      ts.isJsxOpeningElement(node.parent) ||
      ts.isJsxClosingElement(node.parent) ||
      ts.isJsxSelfClosingElement(node.parent)
    ) {
      return true;
    }

    return false;
  }

  private isInsideTypeNode(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (this.isTypeNode(current)) {
        return true;
      }
      if (ts.isExpression(current)) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  private isTypeNode(node: ts.Node): boolean {
    return node.kind >= ts.SyntaxKind.FirstTypeNode &&
      node.kind <= ts.SyntaxKind.LastTypeNode;
  }

  private getReferenceSymbol(
    node: ts.Identifier,
    checker: ts.TypeChecker,
  ): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(node.parent)) {
      return checker.getShorthandAssignmentValueSymbol(node.parent) ??
        checker.getShorthandAssignmentValueSymbol(
          ts.getOriginalNode(node.parent),
        );
    }
    return checker.getSymbolAtLocation(node) ??
      checker.getSymbolAtLocation(ts.getOriginalNode(node));
  }

  private isEnclosingFunctionScopedDeclaration(
    declaration: ts.Declaration,
    func: ts.FunctionLikeDeclaration,
  ): boolean {
    if (isDeclaredWithinFunction(declaration, func)) {
      return false;
    }

    if (
      ts.isImportClause(declaration) ||
      ts.isImportSpecifier(declaration) ||
      ts.isNamespaceImport(declaration) ||
      isModuleScopedDeclaration(declaration)
    ) {
      return false;
    }

    let current: ts.Node | undefined = declaration.parent;
    while (current) {
      if (ts.isFunctionLike(current)) {
        return true;
      }
      if (ts.isSourceFile(current)) {
        return false;
      }
      current = current.parent;
    }

    return false;
  }

  private isCallableReference(
    node: ts.Identifier,
    declarations: readonly ts.Declaration[],
    checker: ts.TypeChecker,
  ): boolean {
    if (
      declarations.some((declaration) => this.isSyntacticCallable(declaration))
    ) {
      return true;
    }

    if (
      !this.isCallableUseSite(node) &&
      !declarations.some((declaration) =>
        this.shouldCheckInferredCallabilityForCapture(declaration)
      )
    ) {
      return false;
    }

    // Keep checker queries narrow; broad validation-time type queries can
    // perturb later schema inference ordering for unrelated expression sites.
    // In addition to direct calls, check inferred callability for captured
    // aliases and contextual bindings so forwarded helpers cannot cross SES
    // callback boundaries unnoticed.
    const type = checker.getTypeAtLocation(node);
    return type.getCallSignatures().length > 0 ||
      type.getConstructSignatures().length > 0;
  }

  private shouldCheckInferredCallabilityForCapture(
    declaration: ts.Declaration,
  ): boolean {
    return (
      ts.isBindingElement(declaration) ||
      ts.isParameter(declaration) ||
      (ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined)
    );
  }

  private isSyntacticCallable(declaration: ts.Declaration): boolean {
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
    ) {
      return true;
    }

    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.initializer) {
        const initializer = declaration.initializer;
        if (
          ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer) ||
          ts.isClassExpression(initializer)
        ) {
          return true;
        }
      }
      return !!declaration.type &&
        this.isCallableTypeNode(declaration.type);
    }

    if (ts.isParameter(declaration)) {
      return !!declaration.type && this.isCallableTypeNode(declaration.type);
    }

    return false;
  }

  private isCallableTypeNode(type: ts.TypeNode): boolean {
    if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
      return true;
    }

    if (ts.isParenthesizedTypeNode(type)) {
      return this.isCallableTypeNode(type.type);
    }

    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      return type.types.some((member) => this.isCallableTypeNode(member));
    }

    if (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === "Function"
    ) {
      return true;
    }

    return false;
  }

  private isCallableUseSite(node: ts.Identifier): boolean {
    const parent = node.parent;
    return !!parent &&
      (
        (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isNewExpression(parent) && parent.expression === node) ||
        (ts.isTaggedTemplateExpression(parent) && parent.tag === node)
      );
  }
}
