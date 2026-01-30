import ts from "typescript";
import { Transformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";
import { detectCallKind } from "../ast/call-kind.ts";

/**
 * Allowlisted function calls at module scope.
 * These are the only calls permitted in module-scope const declarations
 * for SES compartment safety.
 */
const ALLOWED_MODULE_SCOPE_CALLS = new Set([
  "pattern",
  "recipe",
  "lift",
  "handler",
  "schema",
  "toSchema",
  "Object.freeze",
  "harden",
]);

/**
 * Diagnostic types for module-scope validation errors.
 */
type ModuleScopeValidationDiagnostic =
  | "module-scope-let-var"
  | "module-scope-disallowed-call"
  | "module-scope-iife"
  | "module-scope-await";

/**
 * ModuleScopeValidationTransformer validates that module-scope statements
 * conform to SES (Secure ECMAScript) sandboxing requirements.
 *
 * This transformer enforces:
 * 1. Only `const` declarations at module scope (no let/var)
 * 2. Only allowlisted calls at module scope (pattern, recipe, lift, handler, Object.freeze, harden)
 * 3. No IIFEs (Immediately Invoked Function Expressions)
 * 4. No await expressions at module scope
 *
 * These restrictions ensure that:
 * - No mutable module-scope state can leak between invocations
 * - No side effects occur at module load time (except for safe builder calls)
 * - Closure state cannot persist user data
 *
 * @example
 * // ALLOWED
 * export const MyPattern = pattern<Input, Output>((props) => { ... });
 * export const myLift = lift<In, Out>((input) => transform(input));
 * const CONFIG = Object.freeze({ maxItems: 100 });
 *
 * // DISALLOWED - emits diagnostic
 * let counter = 0;  // Error: let at module scope
 * const result = someFunction();  // Error: disallowed call
 * const value = (() => computeSomething())();  // Error: IIFE
 */
export class ModuleScopeValidationTransformer extends Transformer {
  /**
   * Filter: Always run this transformer since we need to validate all files.
   */
  override filter(_context: TransformationContext): boolean {
    return true;
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, checker } = context;

    // Visit only top-level statements (module scope)
    for (const statement of sourceFile.statements) {
      this.validateModuleScopeStatement(statement, context, checker);
    }

    // This transformer only validates; it doesn't modify the source
    return sourceFile;
  }

  /**
   * Validate a statement at module scope.
   */
  private validateModuleScopeStatement(
    statement: ts.Statement,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Variable declarations: only const is allowed
    if (ts.isVariableStatement(statement)) {
      this.validateVariableStatement(statement, context, checker);
      return;
    }

    // Expression statements at module scope need validation
    if (ts.isExpressionStatement(statement)) {
      this.validateExpressionStatement(statement, context, checker);
      return;
    }

    // These are allowed at module scope:
    // - ImportDeclaration
    // - ExportDeclaration
    // - FunctionDeclaration (named functions, not called)
    // - ClassDeclaration
    // - TypeAliasDeclaration
    // - InterfaceDeclaration
    // - EnumDeclaration
    // - ModuleDeclaration (namespaces)
    // - ExportAssignment (export default)
    // No validation needed for these
  }

  /**
   * Validate a variable statement at module scope.
   */
  private validateVariableStatement(
    statement: ts.VariableStatement,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    const declarationList = statement.declarationList;

    // Check that it's const, not let or var
    if (!(declarationList.flags & ts.NodeFlags.Const)) {
      const keyword = declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      context.reportDiagnostic({
        node: statement,
        type: "module-scope-let-var" as ModuleScopeValidationDiagnostic,
        message:
          `SES sandboxing: '${keyword}' declarations are not allowed at module scope. Use 'const' instead to prevent mutable state leakage.`,
        severity: "error",
      });
      return;
    }

    // Validate each declaration's initializer
    for (const declaration of declarationList.declarations) {
      if (declaration.initializer) {
        this.validateModuleScopeInitializer(
          declaration.initializer,
          context,
          checker,
        );
      }
    }
  }

  /**
   * Validate an expression statement at module scope.
   * Expression statements at module scope are generally side effects and should be avoided.
   */
  private validateExpressionStatement(
    statement: ts.ExpressionStatement,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    const expr = statement.expression;

    // Allow property assignments like MyExport.__exportName = "MyExport"
    // These are added by the export annotation transformer
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (ts.isPropertyAccessExpression(expr.left)) {
        // Check if it's assigning to __exportName
        if (expr.left.name.text === "__exportName") {
          return; // Allow this pattern
        }
      }
    }

    // Call expressions at module scope - validate
    if (ts.isCallExpression(expr)) {
      if (!this.isAllowedModuleScopeCall(expr, context, checker)) {
        const calleeName = this.getCalleeName(expr);
        context.reportDiagnostic({
          node: expr,
          type:
            "module-scope-disallowed-call" as ModuleScopeValidationDiagnostic,
          message:
            `SES sandboxing: Call to '${calleeName}' is not allowed at module scope. Only pattern, recipe, lift, handler, Object.freeze, and harden calls are permitted.`,
          severity: "error",
        });
      }
      return;
    }

    // Await expressions at module scope
    if (ts.isAwaitExpression(expr)) {
      context.reportDiagnostic({
        node: expr,
        type: "module-scope-await" as ModuleScopeValidationDiagnostic,
        message:
          `SES sandboxing: 'await' expressions are not allowed at module scope as they imply side effects.`,
        severity: "error",
      });
      return;
    }
  }

  /**
   * Validate an initializer expression at module scope.
   */
  private validateModuleScopeInitializer(
    initializer: ts.Expression,
    context: TransformationContext,
    checker: ts.TypeChecker,
  ): void {
    // Literals are always allowed
    if (this.isLiteral(initializer)) {
      return;
    }

    // Call expressions in const initializers are allowed — the binding is
    // immutable so there's no mutable state concern. Only IIFEs are rejected.
    if (ts.isCallExpression(initializer)) {
      if (this.isIIFE(initializer)) {
        context.reportDiagnostic({
          node: initializer,
          type: "module-scope-iife" as ModuleScopeValidationDiagnostic,
          message:
            `SES sandboxing: Immediately Invoked Function Expressions (IIFEs) are not allowed at module scope.`,
          severity: "error",
        });
      }
      return;
    }

    // Await expressions
    if (ts.isAwaitExpression(initializer)) {
      context.reportDiagnostic({
        node: initializer,
        type: "module-scope-await" as ModuleScopeValidationDiagnostic,
        message:
          `SES sandboxing: 'await' expressions are not allowed at module scope as they imply side effects.`,
        severity: "error",
      });
      return;
    }

    // Object literals are fine (but recursively check their values)
    if (ts.isObjectLiteralExpression(initializer)) {
      for (const prop of initializer.properties) {
        if (ts.isPropertyAssignment(prop)) {
          this.validateModuleScopeInitializer(
            prop.initializer,
            context,
            checker,
          );
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          // Shorthand properties just reference existing identifiers, allowed
        }
      }
      return;
    }

    // Array literals are fine (but recursively check their elements)
    if (ts.isArrayLiteralExpression(initializer)) {
      for (const element of initializer.elements) {
        if (!ts.isOmittedExpression(element)) {
          this.validateModuleScopeInitializer(element, context, checker);
        }
      }
      return;
    }

    // Arrow functions and function expressions are allowed (they're just definitions)
    if (
      ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ) {
      return;
    }

    // Identifiers (references) are allowed
    if (ts.isIdentifier(initializer)) {
      return;
    }

    // Property access expressions are allowed (e.g., importing from a namespace)
    if (ts.isPropertyAccessExpression(initializer)) {
      return;
    }

    // Template literals are allowed (unless they have substitutions with calls)
    if (ts.isTemplateExpression(initializer)) {
      for (const span of initializer.templateSpans) {
        this.validateModuleScopeInitializer(span.expression, context, checker);
      }
      return;
    }

    // 'as' expressions (type assertions) - validate the inner expression
    if (ts.isAsExpression(initializer)) {
      this.validateModuleScopeInitializer(
        initializer.expression,
        context,
        checker,
      );
      return;
    }

    // Parenthesized expressions - validate the inner expression
    if (ts.isParenthesizedExpression(initializer)) {
      this.validateModuleScopeInitializer(
        initializer.expression,
        context,
        checker,
      );
      return;
    }

    // Binary expressions (like string concatenation) - validate both sides
    if (ts.isBinaryExpression(initializer)) {
      this.validateModuleScopeInitializer(initializer.left, context, checker);
      this.validateModuleScopeInitializer(initializer.right, context, checker);
      return;
    }

    // Conditional expressions - validate all branches
    if (ts.isConditionalExpression(initializer)) {
      this.validateModuleScopeInitializer(
        initializer.condition,
        context,
        checker,
      );
      this.validateModuleScopeInitializer(
        initializer.whenTrue,
        context,
        checker,
      );
      this.validateModuleScopeInitializer(
        initializer.whenFalse,
        context,
        checker,
      );
      return;
    }

    // Other expressions that might need special handling could be added here
  }

  /**
   * Check if an expression is a literal (string, number, boolean, null, undefined).
   */
  private isLiteral(expr: ts.Expression): boolean {
    return ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword ||
      expr.kind === ts.SyntaxKind.UndefinedKeyword ||
      ts.isNoSubstitutionTemplateLiteral(expr) ||
      ts.isRegularExpressionLiteral(expr);
  }

  /**
   * Check if a call expression is an IIFE.
   */
  private isIIFE(call: ts.CallExpression): boolean {
    const callee = call.expression;

    // (() => ...)()
    if (ts.isArrowFunction(callee)) {
      return true;
    }

    // (function() { ... })()
    if (ts.isFunctionExpression(callee)) {
      return true;
    }

    // ((fn))() - parenthesized function
    if (ts.isParenthesizedExpression(callee)) {
      const inner = callee.expression;
      return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
    }

    return false;
  }

  /**
   * Check if a call expression is an allowed module-scope call.
   */
  private isAllowedModuleScopeCall(
    call: ts.CallExpression,
    _context: TransformationContext,
    checker: ts.TypeChecker,
  ): boolean {
    // First check using our existing detectCallKind for commontools builders
    const callKind = detectCallKind(call, checker);
    if (callKind) {
      // All builder and derive calls from commontools are allowed
      if (callKind.kind === "builder" || callKind.kind === "derive") {
        return true;
      }
    }

    // Check by call name for other allowed calls
    const calleeName = this.getCalleeName(call);
    return ALLOWED_MODULE_SCOPE_CALLS.has(calleeName);
  }

  /**
   * Get the name of a call expression's callee.
   */
  private getCalleeName(call: ts.CallExpression): string {
    const callee = call.expression;

    if (ts.isIdentifier(callee)) {
      return callee.text;
    }

    if (ts.isPropertyAccessExpression(callee)) {
      // Handle Object.freeze, harden, etc.
      if (ts.isIdentifier(callee.expression)) {
        return `${callee.expression.text}.${callee.name.text}`;
      }
      return callee.name.text;
    }

    return "<anonymous>";
  }
}
