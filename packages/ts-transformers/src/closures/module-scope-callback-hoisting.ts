import ts from "typescript";
import { FUNCTION_HARDENING_HELPER_NAME } from "@commonfabric/utils/sandbox-contract";
import {
  SYNTHETIC_HANDLER_HOIST_PREFIX,
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_MODULE_CALLBACK_PREFIX,
  SYNTHETIC_PATTERN_HOIST_PREFIX,
} from "../ast/call-kind.ts";
import {
  isDeclaredWithinFunction,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";
import { unwrapExpression } from "../utils/expression.ts";
import type { TransformationContext } from "../core/mod.ts";

// `lift`, `handler`, and `pattern` are intentionally absent. The whole-call
// hoisting stage (`BuilderCallHoistingTransformer`) hoists the entire builder call to
// a module-scope const: `lift` (CT-1644), then `handler` and `pattern`
// (CT-1655). Hoisting the *callback* here too would double-hoist — the two
// consts reference each other out of declaration order, a TDZ ReferenceError at
// module load (observed directly: `const __cfPattern_1 = pattern(__cfModuleCallback_1, …)`
// declared before `const __cfModuleCallback_1 = …`). Only `patternTool` remains:
// its whole-call hoist is deferred because its per-instance captures thread
// through the call's own second argument (unlike `pattern`, whose captures live
// in the enclosing `mapWithPattern` params), so relocating the whole call to
// module scope is not obviously capture-safe. When `patternTool` is resolved
// this set empties and this hoister can be deleted.
const HOISTABLE_BUILDER_NAMES = new Set([
  "patternTool",
]);

/**
 * Identifiers that the pipeline itself injects into transformed source
 * and that consequently appear in lowered callback bodies as transformer
 * scaffolding rather than user-authored references. Treat references to
 * these as not contributing to the "uses module-scoped references"
 * signal that gates hoisting — a callback whose only module-level
 * references are synthesized helpers isn't materially benefiting from
 * being moved to module scope.
 *
 * Covers:
 *   - `__cfHelpers`: the helper-module import injected by every transform.
 *   - `__cfHardenFn` (prefix): module-scope function hardening helper.
 *     Matched as a prefix because `module-scope-function-hardening` uses
 *     `createUniqueName`, which defers numeric suffixing to emit, so a
 *     single source file can carry `__cfHardenFn` and `__cfHardenFn_1`
 *     for the same conceptual helper.
 *   - `__cfModuleCallback` (prefix): the hoister's own output. When
 *     hoisting an inner builder callback (e.g. a synthetic lift-applied
 *     wrapper inside a map callback) before its outer callback is
 *     analyzed, the outer
 *     callback's body suddenly contains a `__cfModuleCallback_N`
 *     reference. Without this exclusion, that reference would itself
 *     count as "uses module-scoped references" and incorrectly promote
 *     the outer callback to hoistable. The exclusion keeps the inner
 *     and outer hoist decisions independent.
 *   - `__cfLift` / `__cfHandler` / `__cfPattern` (prefixes): the whole-call
 *     hoisting stage's output (`BuilderCallHoistingTransformer`, CT-1644 lift /
 *     CT-1655 handler + pattern). A hoisted `lift(...)` / `handler(...)` /
 *     `pattern(...)` call leaves a `__cfLift_N(captures)` /
 *     `__cfHandler_N(captures)` / `__cfPattern_N` reference at its original
 *     site. If that site sits inside a callback this hoister analyzes (e.g. a
 *     patternTool callback), the reference must not count as a user-authored
 *     module-scoped reference — same independence rationale as
 *     `__cfModuleCallback` above. (Today the hoisting stage runs *after* this
 *     one, so these references don't yet exist when this hoister analyzes; the
 *     exclusion is kept symmetric with the hoist prefixes so it stays correct
 *     as the unified phase converges and is robust to any future re-ordering.)
 */
function isTransformerInjectedIdentifier(text: string): boolean {
  return text === CF_HELPERS_IDENTIFIER ||
    text.startsWith(FUNCTION_HARDENING_HELPER_NAME) ||
    text.startsWith(SYNTHETIC_MODULE_CALLBACK_PREFIX) ||
    text.startsWith(SYNTHETIC_LIFT_HOIST_PREFIX) ||
    text.startsWith(SYNTHETIC_HANDLER_HOIST_PREFIX) ||
    text.startsWith(SYNTHETIC_PATTERN_HOIST_PREFIX);
}

export function hoistModuleScopedBuilderCallbacks(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): ts.SourceFile {
  const hoistedStatements: ts.Statement[] = [];
  // Counter for synthesizing unique hoisted-callback names per source file.
  // We deliberately do NOT use `context.factory.createUniqueName` here: that
  // helper returns identifiers whose `.text` is the bare prefix
  // (`"__cfModuleCallback"`) and defers numeric suffixing to the emitter at
  // print time. Downstream stages — notably `SchemaInjectionTransformer`'s
  // `getSyntheticModuleCallbackInitializer` (`schema-injection.ts`) — match
  // call-site `__cfModuleCallback_N` references back to their initializers
  // by `identifier.text === declaration.name.text`. With `createUniqueName`
  // every hoisted identifier has the same `.text`, so every lookup matches
  // the first declaration regardless of which `_N` the printed source shows
  // — and capability summaries from the *first* hoisted callback get
  // applied to *every* hoisted callback's call site. Synthesizing the
  // suffix into `.text` directly keeps the identifier's stored name and
  // its printed name in sync, so identity-by-text resolution is sound.
  let hoistCounter = 0;

  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, context.tsContext);
    if (!ts.isCallExpression(visited)) {
      return visited;
    }

    // Try the hoist on this call. Returns the (possibly-hoisted)
    // replacement-or-original argument, advancing hoistCounter and
    // pushing a hoisted const statement as a side-effect when it does
    // hoist.
    const tryHoistCallback = (
      argument: ts.Expression,
    ): ts.Expression => {
      if (
        !isFunctionLikeExpression(argument) ||
        !isNestedWithinFunction(argument)
      ) {
        return argument;
      }

      const analysis = analyzeCallbackForHoisting(argument, context.checker);
      if (!analysis.canHoist) {
        // Debug-only diagnostic: builder callbacks (derive/handler/lift/
        // pattern/patternTool) ought to be hoistable to module scope so
        // they become self-contained, sandbox-safe units. When they
        // capture values from enclosing function scope (even plain JS
        // values), hoisting fails silently and the callback runs inline
        // against the live closure. That works in-process today but
        // breaks the self-contained-callback contract — captured values
        // should be passed in as explicit inputs instead.
        //
        // Gated behind `options.debug` because TS symbol resolution on
        // post-ClosureTransformer ASTs produces phantom enclosing-scope
        // hits for synthesized destructured bindings. The diagnostic is
        // useful for targeted investigation of specific files but too
        // noisy to enable in normal builds. The intended population-scale
        // enumeration uses the post-pipeline probe at
        // `test/diagnostics/probe-derive-callback-captures.ts` instead.
        if (
          context.options.debug &&
          analysis.capturedEnclosingNames.size > 0
        ) {
          const names = Array.from(analysis.capturedEnclosingNames).sort()
            .join(", ");
          context.reportDiagnostic({
            severity: "warning",
            type: "pattern-context:non-hoistable-callback",
            message:
              `Builder callback captures enclosing-scope binding(s) [${names}] ` +
              `and cannot be hoisted to module scope. Captured values should ` +
              `be passed in via the inputs argument so the callback stays ` +
              `self-contained.`,
            node: argument,
          });
        }
        return argument;
      }

      hoistCounter += 1;
      const callbackName = context.factory.createIdentifier(
        `__cfModuleCallback_${hoistCounter}`,
      );
      hoistedStatements.push(
        context.factory.createVariableStatement(
          undefined,
          context.factory.createVariableDeclarationList(
            [
              context.factory.createVariableDeclaration(
                callbackName,
                undefined,
                undefined,
                argument,
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
      );
      return callbackName;
    };

    const target = resolveHoistTarget(visited, context);
    if (target.callbackIndices.length === 0) {
      return visited;
    }

    let changed = false;
    const updatedArgs = visited.arguments.map((argument, index) => {
      if (!target.callbackIndices.includes(index)) {
        return argument;
      }
      const replaced = tryHoistCallback(argument);
      if (replaced !== argument) {
        changed = true;
      }
      return replaced;
    });

    if (!changed) {
      return visited;
    }

    return context.factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      updatedArgs,
    );
  };

  const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile;
  if (hoistedStatements.length === 0) {
    return transformed;
  }

  const insertAt = findHoistInsertionIndex(transformed.statements);
  return context.factory.updateSourceFile(
    transformed,
    [
      ...transformed.statements.slice(0, insertAt),
      ...hoistedStatements,
      ...transformed.statements.slice(insertAt),
    ],
  );
}

function getBuilderCallbackIndices(
  call: ts.CallExpression,
  _context: TransformationContext,
): readonly number[] {
  const callee = unwrapExpression(call.expression);
  const builderName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : undefined;

  // Only the builders in `HOISTABLE_BUILDER_NAMES` are hoisted; anything else
  // (or a malformed call) passes through to validation untouched.
  if (!builderName || !HOISTABLE_BUILDER_NAMES.has(builderName)) {
    return [];
  }

  switch (builderName) {
    case "handler":
    case "pattern":
    case "patternTool":
      return call.arguments.length >= 1 ? [0] : [];
    default:
      return [];
  }
}

/**
 * Result of analyzing a call expression for hoist eligibility: the argument
 * indices whose function-like callbacks are candidates for hoisting (empty
 * when the call is not a hoistable builder).
 */
interface HoistTarget {
  callbackIndices: readonly number[];
}

function resolveHoistTarget(
  call: ts.CallExpression,
  context: TransformationContext,
): HoistTarget {
  const callee = unwrapExpression(call.expression);

  // Lift-applied shape (`__cfHelpers.lift(...)(input)`): the outer call's
  // callee is itself a call expression. As of CT-1644 this hoister no longer
  // touches lift — `BuilderCallHoistingTransformer` (which runs after SchemaInjection)
  // hoists the WHOLE lift call to module scope, callback inline. Hoisting the
  // callback here as well would double-hoist into a TDZ at module load. Refuse
  // all applied-call shapes.
  if (ts.isCallExpression(callee)) {
    return { callbackIndices: [] };
  }

  return { callbackIndices: getBuilderCallbackIndices(call, context) };
}

interface CallbackHoistAnalysis {
  /** True if the callback can be hoisted to module scope. */
  readonly canHoist: boolean;
  /** Distinct names from enclosing-function scope that the callback captures. */
  readonly capturedEnclosingNames: ReadonlySet<string>;
}

function analyzeCallbackForHoisting(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): CallbackHoistAnalysis {
  let usesModuleScopedReferences = false;
  const capturedEnclosingNames = new Set<string>();

  // Pre-compute names declared locally inside the callback (its
  // parameter binding targets plus variable declarations in its body,
  // not descending into nested function-likes). When a referenced
  // identifier's name is in this set, classify it as `local` without
  // going through `getReferenceScope`.
  //
  // This sidesteps the documented synthetic-node hazard in
  // `isDeclaredWithinFunction` (see ast/scope-analysis.ts:70-86):
  // upstream transformers can synthesize callbacks whose body declares
  // locals via synthesized nodes (pos = -1). For those, the
  // symbol-resolution path falls back to the original-AST declaration
  // and concludes the local is captured from enclosing scope, poisoning
  // the hoist decision. Name-based recognition is safe here because the
  // walker already stops at nested function boundaries — we only need
  // to cover names declared in this exact scope.
  const localNames = new Set<string>();
  for (const parameter of callback.parameters) {
    collectBindingNames(parameter.name, localNames);
  }
  if (callback.body) {
    collectLocalDeclarationNames(callback.body, callback, localNames);
  }

  const visit = (node: ts.Node): void => {
    if (
      node !== callback &&
      isFunctionLikeDeclaration(node)
    ) {
      return;
    }

    if (ts.isIdentifier(node)) {
      if (
        !shouldIgnoreReferenceSite(node) &&
        localNames.has(node.text)
      ) {
        // Locally-declared in this callback — skip enclosing/module
        // classification entirely.
        ts.forEachChild(node, visit);
        return;
      }
      const scope = getReferenceScope(node, callback, checker);
      if (scope === "module") {
        usesModuleScopedReferences = true;
      } else if (scope === "enclosing") {
        capturedEnclosingNames.add(node.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  for (const parameter of callback.parameters) {
    if (parameter.initializer) {
      visit(parameter.initializer);
    }
  }

  if (callback.body) {
    visit(callback.body);
  }

  return {
    canHoist: usesModuleScopedReferences && capturedEnclosingNames.size === 0,
    capturedEnclosingNames,
  };
}

function collectBindingNames(
  name: ts.BindingName,
  bucket: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    bucket.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, bucket);
  }
}

function collectLocalDeclarationNames(
  body: ts.Node,
  callback: ts.FunctionLikeDeclaration,
  bucket: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (node !== body && node !== callback && isFunctionLikeDeclaration(node)) {
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, bucket);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

type ReferenceScope = "local" | "module" | "enclosing" | "other";

function getReferenceScope(
  node: ts.Identifier,
  callback: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ReferenceScope {
  if (shouldIgnoreReferenceSite(node)) {
    return "local";
  }

  // Transformer-injected scaffolding (`__cfHelpers`, `__cfHardenFn*`)
  // appears in many lowered callback bodies but doesn't reflect any user-
  // authored module-level reference. Treat as `"other"` so it neither
  // contributes to `usesModuleScopedReferences` nor flags an enclosing
  // capture. Without this, ~60% of array-method callback hoists in the
  // existing fixture suite were false positives — pointed out by Berni
  // in the CT-1585 PR review.
  if (isTransformerInjectedIdentifier(node.text)) {
    return "other";
  }

  const symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) ??
      getShorthandAssignmentValueSymbol(
        ts.getOriginalNode(node.parent),
        checker,
      )
    : checker.getSymbolAtLocation(node) ??
      getSymbolAtLocation(ts.getOriginalNode(node), checker);
  if (!symbol) {
    return "other";
  }

  const declarations = (symbol.getDeclarations() ?? []).filter((decl) =>
    !ts.isShorthandPropertyAssignment(decl)
  );
  if (declarations.length === 0) {
    return "other";
  }

  if (declarations.every((decl) => isDeclaredWithinFunction(decl, callback))) {
    return "local";
  }

  if (declarations.some((decl) => ts.isTypeParameterDeclaration(decl))) {
    return "local";
  }

  // Ambient globals (e.g. `console`, `Math`, `JSON`, `Promise`) have all
  // their declarations in TypeScript's `lib.*.d.ts` files. They aren't
  // module-level bindings of the current module — they're part of the
  // runtime's ambient environment, available everywhere. A callback that
  // only "uses module-scoped references" because it references `console`
  // isn't materially benefiting from being moved to module scope, so
  // classify these as `"other"` rather than `"module"`. Pointed out by
  // Berni in the CT-1585 PR review.
  if (declarations.every((decl) => decl.getSourceFile().isDeclarationFile)) {
    return "other";
  }

  if (
    declarations.some((decl) =>
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl) ||
      isModuleScopedDeclaration(decl)
    )
  ) {
    return "module";
  }

  if (declarations.some((decl) => isDeclaredInEnclosingFunction(decl))) {
    return "enclosing";
  }

  return "other";
}

function shouldIgnoreReferenceSite(node: ts.Identifier): boolean {
  if (!node.parent) {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
  ) {
    return true;
  }

  if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) {
    return true;
  }

  if (ts.isBindingElement(node.parent) && node.parent.propertyName === node) {
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

function isDeclaredInEnclosingFunction(decl: ts.Declaration): boolean {
  let current: ts.Node | undefined = decl;
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

function isFunctionLikeExpression(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isFunctionLikeDeclaration(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
}

function isNestedWithinFunction(node: ts.Node): boolean {
  let current = node.parent ?? ts.getOriginalNode(node).parent;
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

function getSymbolAtLocation(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return node && ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)
    : undefined;
}

function getShorthandAssignmentValueSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return node && ts.isShorthandPropertyAssignment(node)
    ? checker.getShorthandAssignmentValueSymbol(node)
    : undefined;
}

function findHoistInsertionIndex(
  statements: readonly ts.Statement[],
): number {
  let index = 0;
  while (
    index < statements.length && ts.isImportDeclaration(statements[index])
  ) {
    index += 1;
  }
  return index;
}
