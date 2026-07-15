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
 * - Function creation is NOT allowed in pattern context except at supported
 *   callback boundaries, including closure-converted nested pattern builders
 * - lift() and handler() must be defined at module scope, not inside patterns
 *
 * Errors reported:
 * - Property access used in computation: ERROR (must wrap in computed())
 * - Optional chaining:
 *   - optional property/element access is allowed in supported lowerable
 *     expression sites
 *   - optional calls and non-lowerable optional access still error
 * - Calling .get() on cells: ERROR (must wrap in computed())
 * - Unsupported function creation in pattern context: ERROR (move to module
 *   scope or use a supported callback boundary)
 * - lift()/handler() inside pattern: ERROR (move to module scope)
 * - Local computed()/lift() aliases used as plain values in the same
 *   callback: ERROR (use a nested computed()/lift())
 */
import ts from "typescript";
import { detectTrustedFactoryType } from "@commonfabric/schema-generator";
import { COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES } from "../core/commonfabric-runtime-registry.ts";
import { isCommonFabricSymbol } from "../core/common-fabric-symbols.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  classifyArrayMethodCallSite,
  detectCallKind,
  detectDirectBuilderCall,
  findEnclosingPatternBuilderCallbackDescriptor,
  getNodeText,
  getPatternBuilderCallbackDescriptor,
  isInRestrictedReactiveContext,
  isInsideRestrictedContext,
  isInsideSafeCallbackWrapper,
  isStandaloneFunctionDefinition,
} from "../ast/mod.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import {
  addBindingTargetSymbols,
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
const AUTHORED_SECOND_PATTERN_PARAMETER =
  "pattern-callback:authored-second-parameter";
const AUTHORED_REST_PATTERN_INPUT = "pattern-callback:authored-rest-input";
const SES_SELF_CONTAINED_CALLBACK_BOUNDARIES = new Set<
  SupportedCallbackBoundaryKind
>([
  "event-handler",
  "reactive-array-method",
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

type ObjectMemberKind =
  | "getter"
  | "toJSON"
  | "method"
  | "setter"
  | "function-property";

// A getter and a `toJSON()` member run when the pattern result is stored;
// a method, setter, or function-valued property is a function value the data
// model cannot store. The fix advice leads with the option that fits the kind:
// a plain property or computed() field for a value, a module-scope handler() or
// lift() for behavior.
function objectMemberMessage(kind: ObjectMemberKind): string {
  switch (kind) {
    case "getter":
      return `A getter on an object literal in pattern or render context is ` +
        `evaluated when the pattern result is stored, so a reactive value it ` +
        `reads is captured as a one-time snapshot and stops tracking updates. ` +
        `Expose the value as a plain property or a computed(() => ...) field.`;
    case "toJSON":
      return `A toJSON() member on an object literal in pattern or render ` +
        `context runs when the pattern result is stored, so a reactive value ` +
        `it reads is captured as a one-time snapshot and stops tracking ` +
        `updates. Build the serialized shape from plain properties or ` +
        `computed(() => ...) fields.`;
    case "setter":
      return `A setter on an object literal in pattern or render context is a ` +
        `function value, which the reactive data model cannot store. Move this ` +
        `write into a module-scope handler().`;
    case "method":
      return `A method on an object literal in pattern or render context is a ` +
        `function value, which the reactive data model cannot store. Move this ` +
        `behavior into a module-scope handler() or lift(); to expose a value, ` +
        `use a plain property or a computed(() => ...) field.`;
    case "function-property":
      return `A function-valued property on an object literal in pattern or ` +
        `render context is a function value, which the reactive data model ` +
        `cannot store. Move this behavior into a module-scope handler() or ` +
        `lift(); to expose a value, use a plain property or a ` +
        `computed(() => ...) field.`;
  }
}

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

      if (ts.isCallExpression(node)) {
        const descriptor = getPatternBuilderCallbackDescriptor(node, checker);
        const firstParameter = descriptor?.callback.parameters[0];
        if (firstParameter?.dotDotDotToken) {
          context.reportDiagnosticOnce({
            severity: "error",
            type: AUTHORED_REST_PATTERN_INPUT,
            message:
              "Pattern callback argument 0 is one public input value and " +
              "cannot be a rest parameter. Argument 1 is reserved for " +
              "compiler-generated closure params metadata.",
            node: firstParameter,
          });
        }
        const secondParameter = descriptor?.callback.parameters[1];
        if (
          secondParameter &&
          !descriptor.paramsSchemaCarrier
        ) {
          context.reportDiagnosticOnce({
            severity: "error",
            type: AUTHORED_SECOND_PATTERN_PARAMETER,
            message:
              "Pattern callback argument 1 is reserved for compiler-generated " +
              "closure params metadata. Authors may only declare public input " +
              "as callback argument 0.",
            node: secondParameter,
          });
        }
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

      // Check for class creation in pattern context. A class created here has
      // the same footgun as a function: a method or accessor capturing a
      // reactive local reads it as a stale plain snapshot, since the body runs
      // later, outside the reactive graph. Flag the class once and stop
      // descending so its members don't produce cascading diagnostics.
      if (ts.isClassExpression(node) || ts.isClassDeclaration(node)) {
        if (this.validateClassCreation(node, context, checker)) {
          return node;
        }
      }

      // Object-literal methods, getters, and setters are function creation in
      // another syntactic form; the arrow and function-expression spellings are
      // handled above.
      if (
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        this.validateObjectMemberCreation(node, context, checker);
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
   * Functions inside safe wrappers (computed, action, lift, handler), nested
   * pattern callbacks, and supported JSX expressions are allowed because a
   * later transformer gives each boundary a self-contained representation.
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

    // A function that is the value of an object-literal property is a member of
    // that data object, not an event handler or array-method callback. It is
    // rejected even inside JSX, where the expression-site lowering does not
    // descend into it either.
    if (this.isObjectLiteralPropertyValueFunction(node)) {
      const kind = this.propertyValueFunctionKind(node);
      if (
        kind === "toJSON" && !this.memberBodyReadsReactiveValue(node, context)
      ) {
        return;
      }
      this.reportObjectMember(node, kind, context);
      return;
    }

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
        `Note: callbacks inside nested pattern(), computed(), action(), and .map() are allowed.`,
      node,
    });
  }

  /**
   * Validates that classes are not created directly in pattern context.
   * A class method, getter, or setter that captures a reactive value from the
   * pattern body reads it as a stale plain snapshot, because the body runs
   * later, outside the reactive graph. Classes inside safe wrappers (computed,
   * action, lift, handler) run in compute context and are allowed.
   *
   * Returns true when the class was rejected, so the caller can stop descending
   * into its members and avoid cascading per-member diagnostics.
   */
  private validateClassCreation(
    node: ts.ClassExpression | ts.ClassDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): boolean {
    // Skip if inside safe wrapper callback (computed, action, lift, handler)
    if (isInsideSafeCallbackWrapper(node, checker, context)) return false;

    // Only error if inside restricted context (pattern/render)
    if (!isInsideRestrictedContext(node, checker, context)) return false;

    context.reportDiagnostic({
      severity: "error",
      type: "pattern-context:function-creation",
      message: `Class creation is not allowed in pattern context. ` +
        `Move this class to module scope. Methods and accessors that read a ` +
        `reactive value captured from the pattern body see a stale snapshot, ` +
        `since they run later, outside the reactive graph. ` +
        `Note: classes inside computed(), action(), lift(), and handler() are allowed.`,
      node,
    });
    return true;
  }

  /**
   * Validates object-literal methods, getters, and setters created in pattern
   * or render context. The reactive-read lowering pass stops at every function
   * boundary, so a reactive read inside such a body is never tracked. At result
   * serialization a getter (or `toJSON`) runs once and freezes whatever it
   * returns to a snapshot, while a method or setter is a function value the
   * reactive data model cannot store. The whole member is rejected regardless
   * of its body, so reads laundered through destructuring, spread, computed
   * member names, or parameter defaults are covered too. A `toJSON` member is
   * the one exception: it is storable (the data model converts a toJSON-bearing
   * object), so it is reported only when its body reads a reactive value.
   * Members inside a compute wrapper (computed()/lift()/handler()/action()) and
   * object literals outside pattern/render context are left alone. Class members
   * are out of scope for this rule (the gate requires an object-literal parent);
   * a pattern-body class is rejected by the class-creation rule instead. The
   * match is syntactic, so a function value reached through a call or reference
   * rather than written inline (`{ read: makeReader() }`, `{ read: someFn }`) is
   * not caught here.
   */
  private validateObjectMemberCreation(
    node:
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    if (!ts.isObjectLiteralExpression(node.parent)) return;
    if (isInsideSafeCallbackWrapper(node, checker, context)) return;
    if (!isInsideRestrictedContext(node, checker, context)) return;

    const kind = this.objectMemberKind(node);
    if (
      kind === "toJSON" && !this.memberBodyReadsReactiveValue(node, context)
    ) {
      return;
    }
    this.reportObjectMember(node.name, kind, context);
  }

  private objectMemberKind(
    node:
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
  ): ObjectMemberKind {
    if (ts.isGetAccessorDeclaration(node)) return "getter";
    if (ts.isSetAccessorDeclaration(node)) return "setter";
    return this.getStaticMemberName(node.name) === "toJSON"
      ? "toJSON"
      : "method";
  }

  private getStaticMemberName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text;
    }
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (
      ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
    ) {
      return name.expression.text;
    }
    return undefined;
  }

  /**
   * True when an arrow function or function expression is the value of a
   * property assignment on an object literal (e.g. `{ read: () => ... }`).
   * This is the function-valued-property spelling of an object member; the
   * method/getter/setter spellings are matched directly by their node kinds.
   * The function may be wrapped in transparent expressions (parentheses, `as`,
   * `satisfies`, `!`, `<T>`) before the property assignment.
   */
  private isObjectLiteralPropertyValueFunction(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ): boolean {
    return !!this.getObjectLiteralFunctionPropertyAssignment(node);
  }

  // A `toJSON` property is invoked at store time like a `toJSON()` method, so
  // it shares the serialization-snapshot mechanism rather than the
  // unstorable-function one.
  private propertyValueFunctionKind(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ): ObjectMemberKind {
    const property = this.getObjectLiteralFunctionPropertyAssignment(node);
    if (property && this.getStaticMemberName(property.name) === "toJSON") {
      return "toJSON";
    }
    return "function-property";
  }

  /**
   * Walks up from a function node through transparent expression wrappers and
   * returns the enclosing object-literal property assignment when the
   * (possibly-wrapped) function is that property's value. A bare function
   * declaration is never a property value.
   */
  private getObjectLiteralFunctionPropertyAssignment(
    node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ): ts.PropertyAssignment | undefined {
    if (ts.isFunctionDeclaration(node)) return undefined;
    let current: ts.Node = node;
    let parent = current.parent;
    while (parent && this.transparentWrapperInner(parent) === current) {
      current = parent;
      parent = current.parent;
    }
    if (
      parent &&
      ts.isPropertyAssignment(parent) &&
      parent.initializer === current &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      return parent;
    }
    return undefined;
  }

  // Expressions that wrap a value without changing it: parentheses, `as`,
  // `satisfies`, non-null `!`, and `<T>` assertions. Returns the wrapped inner
  // expression, or undefined when the node is not such a wrapper.
  private transparentWrapperInner(node: ts.Node): ts.Expression | undefined {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return node.expression;
    }
    return undefined;
  }

  private reportObjectMember(
    reportNode: ts.Node,
    kind: ObjectMemberKind,
    context: TransformationContext,
  ): void {
    context.reportDiagnostic({
      severity: "error",
      type: "pattern-context:object-member",
      message: objectMemberMessage(kind),
      node: reportNode,
    });
  }

  /**
   * Narrow, toJSON-only body check. A `toJSON` member is the one function shape
   * the data model can store: it converts a toJSON-bearing object via toJSON()
   * rather than throwing. So a `toJSON` that reads no reactive value is storable
   * and allowed; one that reads a reactive value captured from the enclosing
   * pattern still freezes a snapshot at store time and is reported. This is the
   * single exception to the rule's body-agnostic stance, scoped to toJSON.
   */
  private memberBodyReadsReactiveValue(
    fn:
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.FunctionDeclaration,
    context: TransformationContext,
  ): boolean {
    const body = fn.body;
    if (!body) return false;

    // Collect every enclosing function up to the outermost, innermost first.
    // The outermost is the pattern (or render) body, whose parameters are the
    // reactive inputs. A toJSON nested in a callback still captures those outer
    // inputs, so its reads of them count.
    const enclosing: ts.FunctionLikeDeclaration[] = [];
    let cursor: ts.Node | undefined = fn.parent;
    while (cursor) {
      if (ts.isFunctionLike(cursor)) {
        enclosing.push(cursor as ts.FunctionLikeDeclaration);
      }
      cursor = cursor.parent;
    }
    if (enclosing.length === 0) return false;

    // Reactive roots are matched by symbol, not by name, so a member parameter
    // that shadows an input name is not mistaken for the reactive input. Seed
    // the symbols with the outermost (pattern) inputs, then add locals
    // initialized from a reactive value (a reactive-origin call, or a value
    // rebound from an input or earlier reactive local — so reads laundered
    // through `const { auth } = props` or `const a = value` count). A nested
    // callback's own parameter is not seeded, so reading a plain element of a
    // non-reactive array is not flagged.
    const reactiveRootSymbols = new Set<ts.Symbol>();
    const outermost = enclosing[enclosing.length - 1]!;
    for (const parameter of outermost.parameters) {
      addBindingTargetSymbols(
        parameter.name,
        reactiveRootSymbols,
        context.checker,
      );
    }
    for (let i = enclosing.length - 1; i >= 0; i--) {
      const scopeBody = enclosing[i]!.body;
      if (!scopeBody) continue;
      const scan = (current: ts.Node): void => {
        if (current !== scopeBody && ts.isFunctionLike(current)) return;
        if (
          ts.isVariableDeclaration(current) &&
          current.initializer &&
          isOpaqueSourceExpression(
            current.initializer,
            EMPTY_OPAQUE_ROOTS,
            reactiveRootSymbols,
            context,
          )
        ) {
          addBindingTargetSymbols(
            current.name,
            reactiveRootSymbols,
            context.checker,
          );
        }
        ts.forEachChild(current, scan);
      };
      scan(scopeBody);
    }
    if (reactiveRootSymbols.size === 0) {
      return false;
    }

    const readsOpaqueSource = (node: ts.Expression): boolean =>
      isOpaqueSourceExpression(
        node,
        EMPTY_OPAQUE_ROOTS,
        reactiveRootSymbols,
        context,
      );

    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) return;
      if (current !== body && ts.isFunctionLike(current)) return;
      if (
        (ts.isPropertyAccessExpression(current) ||
          ts.isElementAccessExpression(current)) &&
        isTopmostMemberAccess(current) &&
        readsOpaqueSource(current)
      ) {
        found = true;
        return;
      }
      if (
        ts.isIdentifier(current) &&
        !this.isMemberAccessBase(current) &&
        readsOpaqueSource(current)
      ) {
        found = true;
        return;
      }
      if (ts.isCallExpression(current) && readsOpaqueSource(current)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(body);
    // A reactive read in a parameter default runs when the member is called
    // with no argument, so it counts too.
    for (const parameter of fn.parameters) {
      if (parameter.initializer) visit(parameter.initializer);
    }
    return found;
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
    const permitsFactoryCaptures = this.isClosureConvertedNestedPatternBoundary(
      func,
      boundarySemantics,
      checker,
    );

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
          this.isCallableReference(node, declarations, checker) &&
          !(permitsFactoryCaptures &&
            this.isFirstClassFactoryReference(node, checker))
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
   * Only nested patterns that the closure converter will hoist may carry a
   * callable factory through their private params record. Other SES callback
   * boundaries retain the ordinary callable-capture rejection.
   */
  private isClosureConvertedNestedPatternBoundary(
    func: ts.ArrowFunction | ts.FunctionExpression,
    boundarySemantics: CallbackBoundarySemantics,
    checker: ts.TypeChecker,
  ): boolean {
    const decision = boundarySemantics.decision;
    if (
      decision.kind !== "supported" ||
      decision.boundaryKind !== "pattern-builder"
    ) {
      return false;
    }

    const ownPattern = findEnclosingPatternBuilderCallbackDescriptor(
      func,
      checker,
    );
    if (!ownPattern) return false;

    let current: ts.Node | undefined = ownPattern.call.parent;
    while (current) {
      if (
        ts.isCallExpression(current) &&
        getPatternBuilderCallbackDescriptor(current, checker)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Recognize the branded Common Fabric factory protocol semantically. The
   * schema generator supplies the kind/contracts, while the trusted unique-
   * symbol declaration check prevents a user alias merely named
   * `PatternFactory` from granting the exception.
   */
  private isFirstClassFactoryReference(
    node: ts.Identifier,
    checker: ts.TypeChecker,
  ): boolean {
    let type: ts.Type;
    try {
      type = checker.getTypeAtLocation(node);
    } catch {
      return false;
    }

    const members = type.isUnion()
      ? type.types.filter((member) =>
        (member.flags &
          (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) ===
          0
      )
      : [type];
    return members.length > 0 &&
      members.every((member) =>
        detectTrustedFactoryType(member, checker) !== undefined &&
        checker.getPropertiesOfType(member).some((property) =>
          property.getName().startsWith("__@FABRIC_FACTORY_TYPE") &&
          isCommonFabricSymbol(property, checker)
        )
      );
  }

  /**
   * Validates that standalone functions don't use reactive operations like
   * computed(), lift(), or .map() on CellLike types.
   *
   * Standalone functions cannot have their closures captured automatically.
   * Move reactive work into a pattern-owned context, where ordinary inline
   * `pattern(...)` values use the same closure-conversion path as every other
   * first-class factory.
   */
  private validateStandaloneFunction(
    func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
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
                `Move the ${callKind.builderName}() call to module scope or a pattern-owned context.`,
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
                `Move the computed() call to a pattern-owned context.`,
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
                `Move the .${arrayMethodCallSite.family}() call to a pattern-owned context. ` +
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
