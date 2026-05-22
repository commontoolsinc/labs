import ts from "typescript";
import { FUNCTION_HARDENING_HELPER_NAME } from "@commonfabric/utils/sandbox-contract";
import { SYNTHETIC_MODULE_CALLBACK_PREFIX } from "../ast/call-kind.ts";
import {
  isDeclaredWithinFunction,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";
import { unwrapExpression } from "../utils/expression.ts";
import type { TransformationContext } from "../core/mod.ts";

const HOISTABLE_BUILDER_NAMES = new Set([
  "derive",
  "handler",
  "lift",
  "pattern",
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
 *     hoisting an inner builder callback (e.g. a synthetic derive inside
 *     a map callback) before its outer callback is analyzed, the outer
 *     callback's body suddenly contains a `__cfModuleCallback_N`
 *     reference. Without this exclusion, that reference would itself
 *     count as "uses module-scoped references" and incorrectly promote
 *     the outer callback to hoistable. The exclusion keeps the inner
 *     and outer hoist decisions independent.
 */
function isTransformerInjectedIdentifier(text: string): boolean {
  return text === CF_HELPERS_IDENTIFIER ||
    text.startsWith(FUNCTION_HARDENING_HELPER_NAME) ||
    text.startsWith(SYNTHETIC_MODULE_CALLBACK_PREFIX);
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

    const callbackIndices = getBuilderCallbackIndices(visited, context);
    if (callbackIndices.length === 0) {
      return visited;
    }

    let changed = false;
    const updatedArgs = visited.arguments.map((argument, index) => {
      if (!callbackIndices.includes(index)) {
        return argument;
      }
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

      changed = true;
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
  context: TransformationContext,
): readonly number[] {
  const callee = unwrapExpression(call.expression);
  const builderName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : undefined;

  if (!builderName || !HOISTABLE_BUILDER_NAMES.has(builderName)) {
    return [];
  }

  switch (builderName) {
    case "derive": {
      // Schema-injected (4+ arg) derive calls: callback at index 3. This
      // branch is dead at the hoist's current pipeline position (we run
      // before SchemaInjectionTransformer) but keeps the function
      // tolerant of future reordering.
      if (call.arguments.length >= 4) return [3];
      if (call.arguments.length < 2) return [];
      const deriveCallback = call.arguments[1];
      if (!isFunctionLikeExpression(deriveCallback)) return [];
      // Two shapes of 2-arg derive reach the hoister:
      //   (a) Synthetic compute callbacks produced by the closure
      //       transformer's reactive-wrapping (e.g. `__cfHelpers.derive(
      //       captures, ({ item }) => formatPrice(item.price * TAX_RATE))`).
      //       These have destructured params with no explicit type
      //       annotations because the transformer synthesizes them, and
      //       the closure pipeline tags them via
      //       `context.markAsSyntheticComputeCallback`.
      //   (b) User-authored `derive(inputs, callback)` calls written
      //       directly in source — usually with a destructured-and-typed
      //       parameter like `({ x }: { x: T }) => …`. The type
      //       annotation is what makes them safe to relocate to module
      //       scope: it carries the structural contract the runtime
      //       relies on. Untyped user-authored 2-arg derives are
      //       skipped (better to leave them inline than guess).
      if (context.isSyntheticComputeCallback?.(deriveCallback)) return [1];
      if (hasSelfDescribingFunctionTypes(deriveCallback)) return [1];
      return [];
    }
    case "handler":
    case "lift":
    case "pattern":
    case "patternTool":
      return call.arguments.length >= 1 ? [0] : [];
    default:
      return [];
  }
}

function hasSelfDescribingFunctionTypes(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  if (callback.parameters.length === 0) {
    return true;
  }

  return callback.parameters.every((parameter) => parameter.type !== undefined);
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
