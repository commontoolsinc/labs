/**
 * Static Initial `.of()` Validation Transformer
 *
 * Reports a compile-time error when `Cell.of(x)`, `Writable.of(x)`, or any
 * scoped constructor's `.of()` is called with an initial value that is not
 * compile-time static (CT-1880).
 *
 * A cell's initial value is a schema-level `default`: it is embedded into the
 * lowered schemas so every session/scope observes it at read time, and no
 * document is written at instantiation. The transformer can only embed values
 * it can evaluate while compiling, so runtime expressions (e.g.
 * `Cell.of(safeDateNow())`) cannot be defaults — under the old seed-once
 * semantics they were silently visible only to the piece-creating session,
 * which is the bug this contract replaces.
 *
 * The accepted grammar lives in `ast/static-initial.ts` (literals, static
 * array/object literals, and `const`-references to static initializers —
 * shared with default stamping so validation and evaluation cannot drift).
 */
import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { detectCallKind, detectNewExpressionKind } from "../ast/call-kind.ts";
import { evaluateStaticInitial } from "../ast/static-initial.ts";

export class CellOfStaticInitialValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);
        if (callKind?.kind === "cell-factory") {
          this.validateStaticInitial(node, callKind.factoryName, context);
        }
      }
      if (ts.isNewExpression(node)) {
        const callKind = detectNewExpressionKind(node, checker);
        if (callKind?.kind === "cell-factory") {
          this.validateStaticInitial(node, callKind.factoryName, context);
        }
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  private validateStaticInitial(
    call: ts.CallExpression | ts.NewExpression,
    factoryName: string,
    context: TransformationContext,
  ): void {
    const initialArg = call.arguments?.[0];
    if (!initialArg) return;

    const result = evaluateStaticInitial(initialArg, context.checker);
    if (result.ok) return;

    // Build a display name matching the actual call site. Unlike the
    // empty-array validator this renders the full dotted chain, so scoped
    // constructors read as `Writable.perSession.of` rather than bare `of`.
    const displayName = ts.isNewExpression(call)
      ? `new ${factoryName}`
      : dottedCalleeName(call.expression) ?? factoryName;

    context.reportDiagnostic({
      severity: "error",
      type: "cell-factory:non-static-initial",
      message:
        `${displayName}(...) initial values are schema defaults and must be compile-time static: ${result.reason}. ` +
        `To initialize a cell with a runtime value, write it explicitly instead — e.g. \`cell.set(...)\` from a handler, ` +
        `or compare against a pattern-body \`const\` at read time.`,
      node: result.expression,
    });
  }
}

/**
 * Render a callee as its dotted source spelling (`Writable.perSession.of`)
 * when it is a chain of identifiers; undefined for anything more exotic.
 */
function dottedCalleeName(callee: ts.Expression): string | undefined {
  const segments: string[] = [];
  let current: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(current)) {
    if (!ts.isIdentifier(current.name)) return undefined;
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  segments.unshift(current.text);
  return segments.join(".");
}
