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
 * - Optional chaining (?.): ERROR (not allowed in reactive context)
 * - Calling .get() on cells: ERROR (must wrap in computed())
 * - Function creation in pattern context: ERROR (move to module scope)
 * - lift()/handler() inside pattern: ERROR (move to module scope)
 * - Local computed()/derive() aliases used as plain values in the same
 *   callback: ERROR (use a nested computed()/derive())
 */
import ts from "typescript";
import { getCellKind } from "@commontools/schema-generator/cell-brand";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  classifyReactiveContext,
  createDataFlowAnalyzer,
  detectCallKind,
  detectDirectBuilderCall,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
  isReactiveArrayMethodCall,
  isStandaloneFunctionDefinition,
} from "../ast/mod.ts";
import { isOpaqueRefType } from "./opaque-ref/opaque-ref.ts";
import {
  addBindingTargetSymbols,
  collectLocalOpaqueRootSymbols,
  isOpaqueSourceExpression,
  isTopmostMemberAccess,
} from "./opaque-roots.ts";
import {
  findLowerableExpressionSite,
  getExpressionSitePolicyInfo,
} from "./expression-site-lowering.ts";

const EMPTY_OPAQUE_ROOTS = new Set<string>();

export class PatternContextValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;
    const analyze = createDataFlowAnalyzer(checker);

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

        if (
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          this.isComputedLikeCallback(node, checker)
        ) {
          this.validateLocalReactiveAliasUsage(node, context);
        }

        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
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
        if (
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

        // Check for .get() calls
        if (
          this.isGetCall(node) &&
          isInRestrictedReactiveContext(node, checker, context) &&
          !this.isSupportedHelperOwnedCellGetCall(
            node,
            context,
            checker,
            analyze,
          )
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

  private isSupportedHelperOwnedCellGetCall(
    node: ts.CallExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
    analyze: ReturnType<typeof createDataFlowAnalyzer>,
  ): boolean {
    if (!this.isGetCall(node)) {
      return false;
    }

    const target = node.expression;
    if (!ts.isPropertyAccessExpression(target)) {
      return false;
    }

    let receiverType: ts.Type;
    try {
      receiverType = checker.getTypeAtLocation(target.expression);
    } catch {
      return false;
    }

    const cellKind = getCellKind(receiverType, checker);
    if (cellKind !== "cell" && cellKind !== "stream") {
      return false;
    }

    const lowerableSite = findLowerableExpressionSite(node, context, analyze);
    if (!lowerableSite) {
      return false;
    }

    const siteInfo = getExpressionSitePolicyInfo(
      lowerableSite.expression,
      lowerableSite.containerKind,
      context,
      analyze,
    );

    return !!siteInfo.helperBoundaryKind;
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
    if (!isInRestrictedReactiveContext(node, checker, context)) {
      return;
    }

    const expression = node as ts.Expression;
    if (findLowerableExpressionSite(expression, context, analyze)) {
      return;
    }

    // Analyze the expression for reactive dependencies
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

    const bodyContext = classifyReactiveContext(func.body, checker, context);
    if (
      bodyContext.kind !== "pattern" ||
      !this.isPatternOwnedStatementBoundary(func, context, checker)
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
        this.isAssignmentOperator(node.operatorToken.kind)
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

  private isAssignmentOperator(kind: ts.SyntaxKind): boolean {
    return kind >= ts.SyntaxKind.FirstAssignment &&
      kind <= ts.SyntaxKind.LastAssignment;
  }

  private isPatternOwnedStatementBoundary(
    func: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): boolean {
    const parent = func.parent;
    if (
      !parent || !ts.isCallExpression(parent) ||
      !parent.arguments.includes(func)
    ) {
      return false;
    }

    if (this.isPatternOwnedArrayMethodCallback(func, context, checker)) {
      return true;
    }

    const callKind = detectCallKind(parent, checker);
    if (!callKind) return false;

    return callKind.kind === "builder" &&
      (callKind.builderName === "pattern" ||
        callKind.builderName === "render");
  }

  private isPatternOwnedArrayMethodCallback(
    func: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): boolean {
    const parent = func.parent;
    if (
      !parent || !ts.isCallExpression(parent) ||
      !parent.arguments.includes(func)
    ) {
      return false;
    }

    const callKind = detectCallKind(parent, checker);
    if (callKind?.kind !== "array-method") {
      return isReactiveArrayMethodCall(
        parent,
        checker,
        context.options.typeRegistry,
      );
    }

    const callee = parent.expression;
    const receiver = ts.isPropertyAccessExpression(callee)
      ? callee.expression
      : ts.isElementAccessExpression(callee)
      ? callee.expression
      : undefined;
    if (!receiver) {
      return false;
    }

    const owner = this.findEnclosingPatternOwnerCallback(
      func,
      checker,
      context,
    );
    if (!owner) {
      return false;
    }

    const opaqueRootSymbols = new Set<ts.Symbol>();
    for (const parameter of owner.parameters) {
      addBindingTargetSymbols(parameter.name, opaqueRootSymbols, checker);
    }
    for (const symbol of collectLocalOpaqueRootSymbols(owner.body, context)) {
      opaqueRootSymbols.add(symbol);
    }

    return isOpaqueSourceExpression(
      receiver,
      EMPTY_OPAQUE_ROOTS,
      opaqueRootSymbols,
      context,
    );
  }

  private findEnclosingPatternOwnerCallback(
    func: ts.ArrowFunction | ts.FunctionExpression,
    checker: ts.TypeChecker,
    context: TransformationContext,
  ): ts.ArrowFunction | ts.FunctionExpression | undefined {
    let current: ts.Node | undefined = func.parent;
    while (current) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const reactiveContext = classifyReactiveContext(
          current.body,
          checker,
          context,
        );
        if (reactiveContext.kind === "pattern") {
          return current;
        }
      }
      current = current.parent;
    }
    return undefined;
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

    // Skip if this function IS a callback to a safe wrapper
    // e.g., computed(() => ...), action(() => ...), derive(() => ...)
    if (this.isSafeWrapperCallback(node, checker)) return;

    // Only error if inside restricted context (pattern/render)
    if (!isInsideRestrictedContext(node, checker, context)) return;

    if (this.isInsideJsx(node)) {
      if (this.isSupportedJsxCallback(node, checker)) {
        return;
      }

      if (this.isJsxCallbackArgument(node)) {
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

    // array method calls on cells/opaques are transformed, so callbacks are allowed
    if (callKind.kind === "array-method") return true;

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

  private isJsxCallbackArgument(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ): boolean {
    if (ts.isFunctionDeclaration(node)) return false;
    const parent = node.parent;
    return !!parent && ts.isCallExpression(parent) &&
      parent.arguments.includes(node);
  }

  private isSupportedJsxCallback(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    checker: ts.TypeChecker,
  ): boolean {
    if (ts.isFunctionDeclaration(node)) {
      return false;
    }

    const jsxParent = node.parent;
    if (
      ts.isJsxExpression(jsxParent) &&
      ts.isJsxAttribute(jsxParent.parent) &&
      jsxParent.parent.name.getText().startsWith("on")
    ) {
      return true;
    }

    const parent = node.parent;
    if (
      !parent || !ts.isCallExpression(parent) ||
      !parent.arguments.includes(node)
    ) {
      return false;
    }

    const callKind = detectCallKind(parent, checker);
    if (
      callKind?.kind === "array-method" ||
      callKind?.kind === "derive" ||
      callKind?.kind === "pattern-tool"
    ) {
      return true;
    }

    if (callKind?.kind === "builder") {
      return callKind.builderName === "computed" ||
        callKind.builderName === "action" ||
        callKind.builderName === "lift" ||
        callKind.builderName === "handler";
    }

    return this.isValueReturningArrayCallbackCall(parent, checker);
  }

  private isValueReturningArrayCallbackCall(
    call: ts.CallExpression,
    checker: ts.TypeChecker,
  ): boolean {
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!signature || !declaration) {
      return false;
    }

    const owner = this.findDeclarationOwnerName(declaration);
    if (owner !== "Array" && owner !== "ReadonlyArray") {
      return false;
    }

    const returnType = checker.getReturnTypeOfSignature(signature);
    return (returnType.flags & ts.TypeFlags.Void) === 0;
  }

  private findDeclarationOwnerName(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isTypeAliasDeclaration(current)
      ) {
        if (current.name) {
          return current.name.text;
        }
      }
      if (ts.isSourceFile(current)) {
        break;
      }
      current = current.parent;
    }
    return undefined;
  }

  private isComputedLikeCallback(
    node: ts.ArrowFunction | ts.FunctionExpression,
    checker: ts.TypeChecker,
  ): boolean {
    const parent = node.parent;
    if (!parent || !ts.isCallExpression(parent)) return false;
    if (!parent.arguments.includes(node)) return false;

    const callKind = detectCallKind(parent, checker);
    if (!callKind) return false;

    return callKind.kind === "derive" ||
      (callKind.kind === "builder" && callKind.builderName === "computed");
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

          // Check for array method on CellLike types
          if (callKind.kind === "array-method") {
            // Check if this is an array method on a CellLike type (not a plain array)
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
   * Includes OpaqueRef/OpaqueRefMethods because standalone helper functions
   * may accept pattern parameters (typed as OpaqueRef<T[]>) and call .map()
   * on them.
   */
  private isCellLikeOrOpaqueRefType(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): boolean {
    // Check if it's an OpaqueRef type
    if (isOpaqueRefType(type, checker)) {
      return true;
    }

    // Check the type name for Cell-like types
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
