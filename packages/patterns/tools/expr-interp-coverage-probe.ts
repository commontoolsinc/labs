// deno-lint-ignore-file no-external-import
//
// `no-external-import` bans bare `npm:` specifiers in shipping pattern/runtime
// source. This is a standalone MEASUREMENT tool (not shipped, not imported by any
// pattern) that deliberately drives the TypeScript compiler API directly to parse
// the real corpus at the pre-transform AST seam. The patterns package has no
// `typescript` import-map entry (only `@commonfabric/ts-transformers` does), and
// adding one — or a re-export shim in transformer src — would be the very
// production-src change this probe must avoid. So we import `npm:typescript@*`
// (deduped by Deno to the SAME resolved version the transformer package uses, so
// node identity / SyntaxKind constants match) and scope the lint exception to
// this one file.

/**
 * STATIC EXPRESSION-INTERPRETATION COVERAGE PROBE — measures how much of a real
 * loaded pattern's pure leaf computation moves OFF the SES/serialized boundary
 * under the "expression-subset interpretation" design
 * (docs/specs/reactive-interpreter/08-expression-interpretation.md).
 *
 * THE SPLIT IT MEASURES, per pattern:
 *   (A) AUTO-GENERATED expression-computeds — pattern-owned expression SITES (one
 *       of the seven `getExpressionContainerKind` kinds) that contain a reactive
 *       ref AND are in the expression subset (binary arith/compare, ?: / && / ||,
 *       unary !/-/+/~/typeof, member/element access, object/array literal, simple
 *       call). Today these lower to `__cfHelpers.lift(()=>expr)({})` opaque leaves
 *       that need SES to resolve when the pattern is loaded; under §08 they become
 *       native ROG operator ops (NO sandbox).
 *   (B) EXPLICIT `computed()` / `lift()` / `derive()` calls — bodies that can be
 *       arbitrary JS; they STAY opaque `$implRef` leaves.
 *
 *   ratio = A / (A + B)  ≈  the fraction of a loaded pattern's leaf computation
 *   that moves from opaque-SES-leaf to natively-interpreted operator op.
 *
 * WHY THIS SEAM (pre-transform AST, recon seam 1):
 *   The auto-vs-explicit split is NOT recoverable post-transform: explicit
 *   `computed(() => expr)` and an auto-wrapped `a + b` BOTH lower to the identical
 *   `__cfHelpers.lift(() => expr)({})` shape, and the transformer's synthetic
 *   markers (`markAsSyntheticComputeCallback` / `CrossStageState` WeakSets) are
 *   compile-time-only and dropped. So the distinction must be re-derived from the
 *   PRE-TRANSFORM AST, which this probe does: it builds a real `ts.Program` over
 *   each pattern entry (resolving `commonfabric` to the real API d.ts), uses the
 *   REAL transformer predicates (`detectCallKind`, `isReactiveValueExpression`,
 *   `getExpressionContainerKind` logic, `shouldLowerLogicalExpression`) for the
 *   classification it can, and applies the §08 expression-subset definition for
 *   the rest.
 *
 * FIDELITY CAVEAT (read before trusting the absolute A count):
 *   This is the AST APPROXIMATION (seam 1), not the transformer-hook seam (seam
 *   2). Two deliberate simplifications, both fail-CLOSED (never over-count A):
 *     1. "Pattern-owned" is decided STRUCTURALLY: an expression is pattern-owned
 *        iff its nearest enclosing function is the `pattern(...)` callback itself
 *        (or a control/JSX position inside it) and NOT the callback of an explicit
 *        `computed`/`lift`/`derive`/`handler` or an array-method (`map`/`filter`/
 *        `flatMap`). The real transformer's `getReactiveContext` is richer; this
 *        captures the §2.1 principle ("interpret the pattern body; black-box the
 *        explicit-compute bodies") but does not replicate every owner nuance.
 *     2. Array-method callback bodies (`items.map(x => ...)`) are NOT counted as
 *        (A): their reactive sites ARE pattern-owned in the real pipeline and DO
 *        lower to operator ops, but attributing them needs the reactive-collection
 *        provenance analysis. Excluding them UNDER-counts A — the real A is higher.
 *   Net: the reported A/(A+B) is a LOWER BOUND on the auto-generated fraction.
 *
 * CROSS-REFERENCE (--xref): the sibling `coalescing-partition-probe.ts` reports,
 * per pattern, the ROG-level PURE-op census (leaf + access + construct + control).
 * (A) is the AST count of expression SITES that become operator ops; the ratio
 * A/coalescing.pureOps is reported as context for "what fraction of the pure leaf
 * computation (A) represents", with the explicit caveat that the two counts are at
 * DIFFERENT granularities (AST site vs ROG op — one `a + b + c` site can lower to
 * multiple ROG ops; a JSX construct is one ROG `construct` op the §08 design does
 * not touch). Treat the xref ratio as an order-of-magnitude sanity check, not an
 * identity.
 *
 * Reproduce:
 *   cd packages/patterns
 *   deno run -A tools/expr-interp-coverage-probe.ts
 *   deno run -A tools/expr-interp-coverage-probe.ts --json
 *   deno run -A tools/expr-interp-coverage-probe.ts --xref   # + coalescing pureOps
 *
 * HARD SCOPE: real parse/extraction only (no hand estimates); standalone probe;
 * no production-src change.
 */

// Pinned to typescript@5.9.3 — the version deno.lock resolves `npm:typescript@*`
// (the ts-transformers package's spec) to at this commit — so Deno dedupes to ONE
// TypeScript module instance. Node identity / SyntaxKind constants must match
// across this probe and the transformer predicates it reuses.
import ts from "npm:typescript@5.9.3";
import {
  detectCallKind,
  isReactiveValueExpression,
} from "../../ts-transformers/src/ast/mod.ts";

// ---------------------------------------------------------------------------
// Corpus.
// ---------------------------------------------------------------------------

interface CorpusEntry {
  name: string;
  dir: string;
  /** Entry files to parse (relative to the pattern dir). Sub-pattern files that
   * the entry imports are pulled in by the program automatically; we list extra
   * top-level pattern files explicitly when a dir ships more than one. */
  files: string[];
}

const CORPUS: CorpusEntry[] = [
  { name: "lunch-poll", dir: "lunch-poll", files: ["main.tsx"] },
  { name: "notes-list-bench", dir: "notes-list-bench", files: ["main.tsx"] },
  { name: "github-activity", dir: "github-activity", files: ["main.tsx"] },
  {
    name: "cfc-row-label-mailbox",
    dir: "cfc-row-label-mailbox",
    files: ["main.tsx"],
  },
  {
    name: "cfc-agent-prompt-injection-demo",
    dir: "cfc-agent-prompt-injection-demo",
    files: ["main.tsx"],
  },
  { name: "fair-share", dir: "fair-share", files: ["main.tsx"] },
  {
    name: "profile-group-chat",
    dir: "profile-group-chat",
    files: ["main.tsx"],
  },
  // A few more, easy single-file patterns:
  { name: "counter", dir: "counter", files: ["counter.tsx"] },
  { name: "habit-tracker", dir: "habit-tracker", files: ["habit-tracker.tsx"] },
  { name: "do-list", dir: "do-list", files: ["do-list.tsx"] },
];

/** Coalescing-partition-probe pureOps per pattern (for --xref). Captured from
 * `deno run -A tools/coalescing-partition-probe.ts --json` on this same corpus
 * at the same commit; only the seven shared patterns are present there. */
const COALESCING_PURE_OPS: Record<string, number> = {
  "lunch-poll": 515,
  "notes-list-bench": 50,
  "github-activity": 46,
  "cfc-row-label-mailbox": 111,
  "cfc-agent-prompt-injection-demo": 353,
  "fair-share": 234,
  "profile-group-chat": 87,
};

// ---------------------------------------------------------------------------
// Program construction (real ts.Program over the real pattern entry).
// ---------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const API_INDEX = `${REPO}/packages/api/index.ts`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.React,
  jsxFactory: "h",
  jsxFragmentFactory: "h.fragment",
  allowJs: true,
  skipLibCheck: true,
  // The probe needs symbol resolution, not a clean type-check. Loosen strictness
  // so unrelated type errors in a real pattern don't poison `detectCallKind`'s
  // symbol resolution (it tolerates errors; we just want the symbols present).
  strict: false,
  noEmit: true,
};

function buildProgram(entryPaths: string[]): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const origResolve = host.resolveModuleNameLiterals?.bind(host);
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    options,
    containingSourceFile,
    reusedNames,
  ) => {
    return literals.map((lit) => {
      const name = lit.text;
      if (name === "commonfabric" || name === "@commonfabric/common") {
        return {
          resolvedModule: {
            resolvedFileName: API_INDEX,
            extension: ts.Extension.Ts,
          },
        };
      }
      if (name.startsWith("commonfabric/")) {
        // Map sub-entries (schema, cfc) to the API package dir best-effort.
        const sub = name.slice("commonfabric/".length);
        const file = `${REPO}/packages/api/${sub}.ts`;
        return {
          resolvedModule: {
            resolvedFileName: file,
            extension: ts.Extension.Ts,
          },
        };
      }
      if (origResolve) {
        return origResolve(
          [lit],
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
          reusedNames,
        )[0];
      }
      return { resolvedModule: undefined };
    });
  };
  return ts.createProgram(entryPaths, COMPILER_OPTIONS, host);
}

// ---------------------------------------------------------------------------
// Expression-site classification (the §08 expression subset + the seven
// container kinds, mirroring the real transformer predicates).
// ---------------------------------------------------------------------------

/** Operator-form bucket for an eligible (A) site. */
type OperatorForm =
  | "binary"
  | "unary"
  | "ternary"
  | "logical"
  | "access"
  | "call";

/** A "non-subset" form that today stays a leaf even though it sits at a reactive
 * site — the design must grow the supported set to cover these, or they remain
 * SES leaves. */
type OutsideSubsetForm =
  | "method-call"
  | "template-literal"
  | "spread"
  | "tagged-template"
  | "other";

/** The seven `getExpressionContainerKind` kinds — reproduced verbatim from
 * `expression-site-policy.ts::getExpressionContainerKind` (the real classifier),
 * minus the tagged-template-span special case which we fold into template-span
 * via `template-literal` outside-subset accounting. */
function getExpressionContainerKind(expr: ts.Expression): string | undefined {
  const parent = expr.parent;
  if (!parent) return undefined;
  if (ts.isJsxExpression(parent) && parent.expression === expr) {
    return "jsx-expression";
  }
  if (
    ts.isTemplateSpan(parent) && parent.expression === expr
  ) {
    return "template-span";
  }
  if (
    (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
    parent.body === expr
  ) {
    return "return-expression";
  }
  if (ts.isReturnStatement(parent) && parent.expression === expr) {
    return "return-expression";
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === expr) {
    return "variable-initializer";
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(expr)) {
    return "call-argument";
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === expr) {
    return "object-property";
  }
  if (
    ts.isArrayLiteralExpression(parent) && parent.elements.includes(expr)
  ) {
    return "array-element";
  }
  return undefined;
}

const SUBSET_BINARY_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const LOGICAL_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
]);

const SUBSET_UNARY_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.TildeToken,
]);

function stripWrappers(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  while (true) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return cur;
}

/**
 * Classification of a head expression at a container site:
 *   - { form }       : in the §08 operator-op subset (an SES leaf today → native
 *                      op under §08). This is an (A) site.
 *   - "transparent"  : a container the transformer does NOT wrap (object/array
 *                      literal — `emitContainerExpression` descends into children
 *                      rather than wrapping; §2 maps it to the EXISTING `construct`
 *                      op). NOT a leaf, NOT (A); the walker descends into it.
 *   - undefined      : not in the subset and not transparent — a fallback leaf
 *                      (method call, template literal, builder/control call, …).
 */
interface SubsetClassification {
  form: OperatorForm;
}

const CONTROL_OR_BUILDER_KINDS = new Set([
  "ifElse",
  "when",
  "unless",
  "builder",
  "pattern-tool",
  "wish",
  "generate-text",
  "generate-object",
  "cell-factory",
  "cell-for",
  "runtime-call",
]);

function classifyExpressionSubset(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): SubsetClassification | "transparent" | undefined {
  const e = stripWrappers(expr);

  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (LOGICAL_OPS.has(op)) return { form: "logical" };
    if (SUBSET_BINARY_OPS.has(op)) return { form: "binary" };
    return undefined; // assignment, comma, instanceof, in — not in subset
  }
  if (ts.isPrefixUnaryExpression(e) && SUBSET_UNARY_OPS.has(e.operator)) {
    return { form: "unary" };
  }
  if (ts.isTypeOfExpression(e)) return { form: "unary" };
  if (ts.isConditionalExpression(e)) return { form: "ternary" };
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    return { form: "access" };
  }
  if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) {
    // §2: the transformer descends into the literal's children (the existing
    // `construct` op already covers it); the literal itself is NOT a lift leaf.
    return "transparent";
  }
  if (ts.isCallExpression(e)) {
    // A "simple call" in the §08 subset is a pure call to another lift/op via a
    // bare identifier. A method call (`x.foo(...)`) stays a leaf (OQ-E4). A call
    // that resolves to a BUILDER / CONTROL helper (computed/lift/derive/handler/
    // pattern/ifElse/when/unless/wish/generate*/cell-*/runtime) is NOT a pure
    // pattern-owned expression leaf — it is (B) (explicit computes, counted
    // separately) or a control/boundary node, NOT an operator op. Exclude them.
    const callee = stripWrappers(e.expression);
    if (!ts.isIdentifier(callee)) return undefined; // method/computed-member call
    const kind = detectCallKind(e, checker);
    if (kind && CONTROL_OR_BUILDER_KINDS.has(kind.kind)) {
      return undefined;
    }
    if (kind?.kind === "array-method") return undefined;
    return { form: "call" };
  }
  return undefined;
}

/** Classify a non-subset reactive head as one of the flagged outside-subset
 * forms (method call, template literal, spread, tagged template). */
function classifyOutsideSubset(
  expr: ts.Expression,
): OutsideSubsetForm | undefined {
  const e = stripWrappers(expr);
  if (ts.isCallExpression(e)) {
    const callee = stripWrappers(e.expression);
    if (
      ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)
    ) {
      return "method-call";
    }
    return undefined;
  }
  if (ts.isTemplateExpression(e)) return "template-literal";
  if (ts.isTaggedTemplateExpression(e)) return "tagged-template";
  if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) return "spread";
  return undefined;
}

const EXPLICIT_COMPUTE_BUILDERS = new Set(["computed", "lift", "derive"]);

/**
 * True if an explicit compute call's callback body is a SINGLE expression that
 * is itself in the §08 subset (concise-arrow body, or a one-statement block that
 * is just `return <subset-expr>`). Used for the informational `bSubsetEligible`
 * stat — these explicit computes are structurally identical to auto-sites.
 */
function isBComputeSubsetEligible(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const cb = call.arguments[call.arguments.length - 1];
  if (!cb) return false;
  const fn = stripWrappers(cb);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  let body: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return false;
    const stmt = fn.body.statements[0];
    if (!ts.isReturnStatement(stmt) || !stmt.expression) return false;
    body = stmt.expression;
  } else {
    body = fn.body;
  }
  const cls = classifyExpressionSubset(body, checker);
  return cls !== undefined && cls !== "transparent";
}

// ---------------------------------------------------------------------------
// Reactive-context (pattern-owned vs explicit-compute body) — structural.
// ---------------------------------------------------------------------------

/**
 * Returns true iff `node` sits inside a `pattern(...)` callback AND its nearest
 * enclosing function is the pattern callback (or a JSX/control position inside
 * it) rather than the callback of an explicit `computed`/`lift`/`derive`/
 * `handler` call or an array-method (`map`/`filter`/`flatMap`).
 *
 * This is the §2.1 boundary, structurally: interpret the pattern body; black-box
 * the explicit-compute bodies. It deliberately UNDER-includes array-method
 * callbacks (their sites are pattern-owned in the real pipeline) — a fail-closed
 * approximation that under-counts A.
 */
/** When true, array-method callback bodies (`items.map(x => ...)`) are treated
 * as pattern-owned (their reactive sites DO lower to operator ops in the real
 * pipeline). Default false = the conservative LOWER BOUND on A. */
let INCLUDE_ARRAY_METHOD_BODIES = false;

function isPatternOwned(node: ts.Node, checker: ts.TypeChecker): boolean {
  let insidePattern = false;
  let cur: ts.Node | undefined = node.parent;
  let crossedFunction = false;

  while (cur) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      // Is this function the callback of a call we care about?
      const owner = enclosingCallForCallback(cur);
      if (owner) {
        const kind = detectCallKind(owner.call, checker);
        if (kind?.kind === "builder" && kind.builderName === "pattern") {
          // The first function we cross going up is the pattern callback →
          // pattern-owned (if no explicit-compute function was crossed first).
          if (!crossedFunction) {
            insidePattern = true;
          }
          // Once we hit the pattern callback we can stop; ownership is decided.
          return insidePattern && !crossedFunction;
        }
        if (
          kind?.kind === "builder" &&
          (EXPLICIT_COMPUTE_BUILDERS.has(kind.builderName) ||
            kind.builderName === "handler" || kind.builderName === "action")
        ) {
          crossedFunction = true;
        } else if (
          kind?.kind === "array-method" || isArrayMethodCall(owner.call)
        ) {
          // Array-method element bodies are pattern-owned in the real pipeline
          // (their per-element sites lower to operator ops). Only mark them
          // opaque in the conservative lower-bound mode.
          if (!INCLUDE_ARRAY_METHOD_BODIES) crossedFunction = true;
        } else if (
          kind?.kind === "ifElse" || kind?.kind === "when" ||
          kind?.kind === "unless"
        ) {
          // Control helper branch callbacks are pattern-owned positions; do not
          // mark crossedFunction. (A ternary/branch is interpreted under §08.)
        } else {
          // Some other callback (e.g. event handler arrow, generic fn) → not
          // pattern-owned.
          crossedFunction = true;
        }
      } else {
        // A bare nested function not recognized as a known callback → opaque.
        crossedFunction = true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

/** The call expression a function expression is the callback argument of, plus
 * the argument index, or undefined. */
function enclosingCallForCallback(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): { call: ts.CallExpression; index: number } | undefined {
  const parent = fn.parent;
  if (parent && ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(fn);
    if (index >= 0) return { call: parent, index };
  }
  return undefined;
}

const ARRAY_METHOD_NAMES = new Set([
  "map",
  "filter",
  "flatMap",
  "mapWithPattern",
  "filterWithPattern",
  "flatMapWithPattern",
]);

function isArrayMethodCall(call: ts.CallExpression): boolean {
  const callee = stripWrappers(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    return ARRAY_METHOD_NAMES.has(callee.name.text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The walk: count (A) sites and (B) explicit lifts per source file.
// ---------------------------------------------------------------------------

interface PatternCounts {
  /** (A) operator-op-eligible expression sites, by operator form. */
  formA: Record<OperatorForm, number>;
  /** total (A). */
  totalA: number;
  /** (B) explicit computed/lift/derive calls (pattern-owned reactive). */
  totalB: number;
  /** Subset of (B) whose callback body is a SINGLE expression already in the
   * §08 subset (e.g. `computed(() => a + b)`). These STAY opaque under §08 (the
   * design black-boxes all explicit computes), but the count shows how many
   * explicit computes are "morally auto-sites" the author wrote by hand —
   * candidates a future heuristic could also interpret. Informational only. */
  bSubsetEligible: number;
  /** Outside-subset reactive sites that stay leaves, by form (flagged). */
  outside: Record<OutsideSubsetForm, number>;
}

function emptyCounts(): PatternCounts {
  return {
    formA: {
      binary: 0,
      unary: 0,
      ternary: 0,
      logical: 0,
      access: 0,
      call: 0,
    },
    totalA: 0,
    totalB: 0,
    bSubsetEligible: 0,
    outside: {
      "method-call": 0,
      "template-literal": 0,
      "spread": 0,
      "tagged-template": 0,
      "other": 0,
    },
  };
}

/**
 * Does `expr` (or any descendant before crossing a function boundary) reference
 * a reactive value? Uses the real `isReactiveValueExpression` on identifier /
 * access leaves. Mirrors the transformer gate `containsOpaqueRef`.
 */
function containsReactiveRef(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // Do not descend into nested functions — their reads are their own context.
    if (
      n !== expr &&
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
        ts.isFunctionDeclaration(n))
    ) {
      return;
    }
    if (
      ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) ||
      ts.isElementAccessExpression(n) || ts.isCallExpression(n)
    ) {
      try {
        if (isReactiveValueExpression(n as ts.Expression, checker)) {
          found = true;
          return;
        }
      } catch {
        // ignore resolution failures
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

function analyzeSourceFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): PatternCounts {
  const counts = emptyCounts();

  // ----- (B): explicit computed/lift/derive calls that are pattern-owned. -----
  // ----- (A): pattern-owned expression sites in the subset. -----
  // We do a single walk. For (A) we only count the MAXIMAL eligible expression
  // at each container site (the transformer emits one wrapper per site, then
  // descends), so once we count a site we descend to find NESTED container sites
  // and nested fallback (outside-subset) leaves, but do not re-count the same
  // expression at a finer granularity.

  const visit = (node: ts.Node): void => {
    // (B) explicit compute builder calls.
    if (ts.isCallExpression(node)) {
      const kind = detectCallKind(node, checker);
      if (
        kind?.kind === "builder" &&
        EXPLICIT_COMPUTE_BUILDERS.has(kind.builderName)
      ) {
        if (isPatternOwned(node, checker)) {
          counts.totalB++;
          if (isBComputeSubsetEligible(node, checker)) counts.bSubsetEligible++;
        }
        // Descend into the callback body — its INTERIOR is opaque (a leaf), so we
        // do NOT count interior expression sites as (A). Skip the subtree for A,
        // but still recurse to find nested explicit computes / nested patterns.
        for (const arg of node.arguments) {
          ts.forEachChild(arg, visitOpaqueInterior);
        }
        return;
      }
    }

    // (A) expression-site eligibility: the node occupies a container kind.
    if (ts.isExpression(node)) {
      const container = getExpressionContainerKind(node);
      if (container) {
        const owned = isPatternOwned(node, checker);
        if (owned && containsReactiveRef(node, checker)) {
          if (handleReactiveSite(node, checker, counts)) return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  // Inside an explicit-compute body: still find nested explicit computes and
  // nested patterns, but do NOT count interior expression sites as A.
  const visitOpaqueInterior = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = detectCallKind(node, checker);
      if (
        kind?.kind === "builder" && kind.builderName === "pattern"
      ) {
        // A nested pattern restarts pattern ownership.
        visit(node);
        return;
      }
    }
    ts.forEachChild(node, visitOpaqueInterior);
  };

  visit(sf);
  return counts;
}

/**
 * After counting a head (A) site, descend into its children to count NESTED
 * container sites (e.g. an array literal element that is itself `a + b`) and
 * nested outside-subset leaves, without re-counting the head. We re-enter the
 * top-level `visit`-style logic via a localized walker.
 */
function descendForNested(
  head: ts.Expression,
  checker: ts.TypeChecker,
  counts: PatternCounts,
): void {
  const e = stripWrappers(head);
  ts.forEachChild(e, (child) => {
    walkNested(child, checker, counts);
  });
}

function walkNested(
  node: ts.Node,
  checker: ts.TypeChecker,
  counts: PatternCounts,
): void {
  // A nested explicit compute is (B).
  if (ts.isCallExpression(node)) {
    const kind = detectCallKind(node, checker);
    if (
      kind?.kind === "builder" &&
      EXPLICIT_COMPUTE_BUILDERS.has(kind.builderName)
    ) {
      if (isPatternOwned(node, checker)) {
        counts.totalB++;
        if (isBComputeSubsetEligible(node, checker)) counts.bSubsetEligible++;
      }
      for (const arg of node.arguments) {
        ts.forEachChild(arg, (n) => walkNestedOpaque(n, checker, counts));
      }
      return;
    }
  }

  if (ts.isExpression(node)) {
    const container = getExpressionContainerKind(node);
    if (container) {
      if (isPatternOwned(node, checker) && containsReactiveRef(node, checker)) {
        if (handleReactiveSite(node, checker, counts)) return;
      }
    }
  }

  ts.forEachChild(node, (c) => walkNested(c, checker, counts));
}

/**
 * A pattern-owned reactive expression at a container site. Classify the HEAD:
 *   - in the §08 subset  → count (A) by form, then descend for nested sites.
 *   - transparent literal → descend only (NOT a leaf, §2 construct op).
 *   - a fallback-leaf computation (method call / template literal / builder /
 *     control call) → count as outside-subset (flagged), then descend.
 *   - a bare reactive read (identifier / direct access with no operator) is
 *     NOT a computation leaf at all — the transformer emits a plain reactive
 *     binding, no lift. Do NOT count; just descend.
 * Returns true if the site was handled here (caller must not recurse further),
 * false to let the caller's normal `forEachChild` recursion proceed.
 */
function handleReactiveSite(
  node: ts.Expression,
  checker: ts.TypeChecker,
  counts: PatternCounts,
): boolean {
  const subset = classifyExpressionSubset(node, checker);
  if (subset === "transparent") {
    descendForNested(node, checker, counts);
    return true;
  }
  if (subset) {
    counts.formA[subset.form]++;
    counts.totalA++;
    descendForNested(node, checker, counts);
    return true;
  }
  // Not in the subset. Is it a genuine fallback-leaf computation, or just a bare
  // reactive read (not a leaf)?
  const outside = classifyOutsideSubset(node);
  if (outside) {
    counts.outside[outside]++;
    descendForNested(node, checker, counts);
    return true;
  }
  // Bare reactive identifier / simple reactive access that the access emitter
  // would NOT wrap (a direct cell read), or an unclassified head — not a leaf.
  // Let normal recursion continue to find nested computation sites.
  return false;
}

function walkNestedOpaque(
  node: ts.Node,
  checker: ts.TypeChecker,
  counts: PatternCounts,
): void {
  if (ts.isCallExpression(node)) {
    const kind = detectCallKind(node, checker);
    if (kind?.kind === "builder" && kind.builderName === "pattern") {
      walkNested(node, checker, counts);
      return;
    }
  }
  ts.forEachChild(node, (c) => walkNestedOpaque(c, checker, counts));
}

// ---------------------------------------------------------------------------
// Run + report.
// ---------------------------------------------------------------------------

function mergeCounts(into: PatternCounts, from: PatternCounts): void {
  for (const k of Object.keys(into.formA) as OperatorForm[]) {
    into.formA[k] += from.formA[k];
  }
  into.totalA += from.totalA;
  into.totalB += from.totalB;
  into.bSubsetEligible += from.bSubsetEligible;
  for (const k of Object.keys(into.outside) as OutsideSubsetForm[]) {
    into.outside[k] += from.outside[k];
  }
}

interface Row {
  name: string;
  ok: boolean;
  error?: string;
  counts?: PatternCounts;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function main(): void {
  const emitJson = Deno.args.includes("--json");
  const xref = Deno.args.includes("--xref");
  INCLUDE_ARRAY_METHOD_BODIES = Deno.args.includes("--include-array-bodies");

  const rows: Row[] = [];
  for (const entry of CORPUS) {
    try {
      const entryPaths = entry.files.map((f) => `${ROOT}/${entry.dir}/${f}`);
      const program = buildProgram(entryPaths);
      const checker = program.getTypeChecker();
      const counts = emptyCounts();
      for (const p of entryPaths) {
        const sf = program.getSourceFile(p);
        if (!sf) {
          throw new Error(`no source file for ${p}`);
        }
        mergeCounts(counts, analyzeSourceFile(sf, checker));
      }
      rows.push({ name: entry.name, ok: true, counts });
    } catch (e) {
      rows.push({
        name: entry.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  console.log("");
  console.log(
    "############ STATIC EXPRESSION-INTERPRETATION COVERAGE PROBE (§08) ############",
  );
  console.log(
    "(A) = pattern-owned expression SITES in the §08 subset that today lower to",
  );
  console.log(
    "    opaque __cfHelpers.lift(()=>expr) leaves and would become native ROG",
  );
  console.log(
    "    operator ops (NO SES). (B) = explicit computed/lift/derive (stay opaque).",
  );
  console.log(
    "A/(A+B) = fraction of leaf computation that leaves the SES boundary. SEAM:",
  );
  console.log(
    "pre-transform AST (seam 1) — a LOWER BOUND on A (array-method bodies excluded).",
  );
  console.log("");

  const HDR = pad("PATTERN", 32) + padL("A", 6) + padL("B", 5) +
    padL("A/(A+B)", 9) + padL("bin", 5) + padL("un", 4) + padL("tern", 5) +
    padL("logic", 6) + padL("acc", 5) + padL("call", 5);
  console.log(HDR);
  console.log("-".repeat(HDR.length));

  const agg = emptyCounts();
  for (const r of rows) {
    if (!r.ok || !r.counts) {
      console.log(pad(r.name, 32) + "  FAILED: " + (r.error ?? ""));
      continue;
    }
    const c = r.counts;
    console.log(
      pad(r.name, 32) +
        padL(String(c.totalA), 6) +
        padL(String(c.totalB), 5) +
        padL(pct(c.totalA, c.totalA + c.totalB), 9) +
        padL(String(c.formA.binary), 5) +
        padL(String(c.formA.unary), 4) +
        padL(String(c.formA.ternary), 5) +
        padL(String(c.formA.logical), 6) +
        padL(String(c.formA.access), 5) +
        padL(String(c.formA.call), 5),
    );
    mergeCounts(agg, c);
  }
  console.log("-".repeat(HDR.length));
  console.log(
    pad("CORPUS AGGREGATE", 32) +
      padL(String(agg.totalA), 6) +
      padL(String(agg.totalB), 5) +
      padL(pct(agg.totalA, agg.totalA + agg.totalB), 9) +
      padL(String(agg.formA.binary), 5) +
      padL(String(agg.formA.unary), 4) +
      padL(String(agg.formA.ternary), 5) +
      padL(String(agg.formA.logical), 6) +
      padL(String(agg.formA.access), 5) +
      padL(String(agg.formA.call), 5),
  );

  // --- Operator-form coverage ranking (which ops to support first). ---
  console.log("");
  console.log("=== (A) BY OPERATOR FORM — which ops cover the most sites ===");
  const formEntries = (Object.keys(agg.formA) as OperatorForm[])
    .map((f) => [f, agg.formA[f]] as const)
    .sort((a, b) => b[1] - a[1]);
  let cumulative = 0;
  for (const [f, n] of formEntries) {
    cumulative += n;
    console.log(
      `  ${pad(f, 10)} ${padL(String(n), 5)}  ${
        padL(pct(n, agg.totalA), 7)
      } of A   (cum ${padL(pct(cumulative, agg.totalA), 7)})`,
    );
  }

  // --- Outside-subset forms that stay leaves (the flagged gaps). ---
  console.log("");
  console.log(
    "=== OUTSIDE THE SUBSET (reactive sites that STAY leaves under §08) ===",
  );
  const outsideTotal = (Object.values(agg.outside) as number[]).reduce(
    (a, b) => a + b,
    0,
  );
  for (const k of Object.keys(agg.outside) as OutsideSubsetForm[]) {
    console.log(`  ${pad(k, 16)} ${padL(String(agg.outside[k]), 5)}`);
  }
  console.log(
    `  ${pad("(total)", 16)} ${padL(String(outsideTotal), 5)}  ` +
      `— these are the §2 fallback leaves the supported set must grow to cover.`,
  );

  // --- Headline. ---
  console.log("");
  console.log("=== HEADLINE ===");
  console.log(
    `  Across ${rows.filter((r) => r.ok).length}/${rows.length} patterns:` +
      ` A=${agg.totalA} auto-generated expression sites vs B=${agg.totalB}` +
      ` explicit lifts.`,
  );
  console.log(
    `  A/(A+B) = ${pct(agg.totalA, agg.totalA + agg.totalB)} of leaf` +
      ` computation sites move OFF the SES/serialized boundary` +
      (INCLUDE_ARRAY_METHOD_BODIES ? "." : " (LOWER BOUND)."),
  );
  console.log(
    `  Of the ${agg.totalB} explicit computes, ${agg.bSubsetEligible}` +
      ` (${
        pct(agg.bSubsetEligible, agg.totalB)
      }) have a single-expression body` +
      ` already IN the §08 subset — they STAY opaque (design black-boxes all`,
  );
  console.log(
    `  explicit computes), but show how many hand-written computes are` +
      ` "morally auto-sites". Counting those as interpretable would lift the` +
      ` ratio to ${
        pct(agg.totalA + agg.bSubsetEligible, agg.totalA + agg.totalB)
      }.`,
  );

  // --- Cross-reference with coalescing pureOps. ---
  if (xref) {
    console.log("");
    console.log(
      "=== XREF vs coalescing-partition-probe pureOps (DIFFERENT granularity) ===",
    );
    console.log(
      "  AST (A) = expression SITES; coalescing pureOps = ROG pure ops (leaf +",
    );
    console.log(
      "  access + construct + control). One site can lower to several ops; many",
    );
    console.log(
      "  construct ops (JSX/object assembly) are NOT §08 expr ops. So A/pureOps is",
    );
    console.log("  a context ratio, NOT an identity. Order-of-magnitude only.");
    console.log("");
    console.log(
      "  " + pad("PATTERN", 32) + padL("A", 6) + padL("pureOps", 9) +
        padL("A/pureOps", 11),
    );
    let aShared = 0;
    let pureShared = 0;
    for (const r of rows) {
      if (!r.ok || !r.counts) continue;
      const pure = COALESCING_PURE_OPS[r.name];
      if (pure === undefined) continue;
      aShared += r.counts.totalA;
      pureShared += pure;
      console.log(
        "  " + pad(r.name, 32) + padL(String(r.counts.totalA), 6) +
          padL(String(pure), 9) + padL(pct(r.counts.totalA, pure), 11),
      );
    }
    console.log(
      "  " + pad("SHARED-CORPUS TOTAL", 32) + padL(String(aShared), 6) +
        padL(String(pureShared), 9) + padL(pct(aShared, pureShared), 11),
    );
  }

  // --- Honest caveats. ---
  console.log("");
  console.log("=== READ THE NUMBERS HONESTLY ===");
  console.log(
    "  * SEAM: pre-transform AST. (A) is the §08 expression subset applied to the",
  );
  console.log(
    "    seven container-kind sites that contain a reactive ref, minus explicit",
  );
  console.log(
    "    computed/lift/derive calls — using the REAL transformer predicates",
  );
  console.log(
    "    (detectCallKind, isReactiveValueExpression, getExpressionContainerKind).",
  );
  console.log(
    "  * LOWER BOUND on A: array-method callback bodies (map/filter/flatMap) are",
  );
  console.log(
    "    excluded though their sites are pattern-owned and DO lower to operator",
  );
  console.log(
    "    ops; the real A (transformer-hook seam) is HIGHER.",
  );
  console.log(
    "  * (B) counts explicit compute CALLS, not their interior op count: one",
  );
  console.log(
    "    computed() with a 5-op body is B=1. A is SITE count too, so A/(A+B) is a",
  );
  console.log(
    "    leaf-COUNT ratio (sites that need no SES vs sites that do), which is the",
  );
  console.log(
    "    serialized-boundary question the design asks.",
  );

  if (emitJson) {
    console.log("");
    console.log(JSON.stringify(
      {
        kind: "expr-interp-coverage-probe",
        rows: rows.map((r) => ({
          name: r.name,
          ok: r.ok,
          error: r.error,
          counts: r.counts,
          ratio: r.counts
            ? r.counts.totalA / (r.counts.totalA + r.counts.totalB || 1)
            : undefined,
        })),
        aggregate: {
          ...agg,
          ratio: agg.totalA / (agg.totalA + agg.totalB || 1),
        },
      },
      null,
      2,
    ));
  }
}

if (import.meta.main) {
  main();
}
