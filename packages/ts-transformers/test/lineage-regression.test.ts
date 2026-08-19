import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import { BINDING_IDENTITY_HELPER_NAME } from "@commonfabric/utils/sandbox-contract";
import { recoverAuthoredPosition } from "../src/ast/mod.ts";
import { CommonFabricTransformerPipeline } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { batchTypeCheckFixtures } from "./utils.ts";

/**
 * CT-1868 lineage regression — the hermetic, tracked form of the transform-time
 * lineage probe documented in `APRIME-LINEAGE-HANDOFF.md` §3/§11.
 *
 * The transformer pipeline must arrive at BuilderCallHoisting with every
 * hoisted / authored builder call — its inner call AND its callback — still
 * carrying a recoverable AUTHORED source position. Before the fix these arrived
 * bare (`pos: -1`, no sourceMapRange, no original chain), so transform-time /
 * debug source resolution had nothing to read. The fix carries lineage across
 * the closure strategies, the expression-rewrite emitters and the
 * SchemaInjection rebuilds (see `preserveLineage` / `preserveSourceMapRange` in
 * `src/ast/utils.ts` — sourceMapRange is the carrier; the SchemaInjection
 * rebuilds stay `create*` and wrap in `preserveSourceMapRange`).
 *
 * This drives the REAL pipeline over a multi-origin fixture, then checks the
 * transformed AST three ways (each closing a review-found gap):
 *   1. per-{tag, role} recovery — every hoisted const, in-place authored
 *      builder, and export-default call/callback recovers a position;
 *   2. per-tag CONTENT binding — each hoist's recovered text must contain its
 *      OWN origin's distinctive marker, claimed exactly once (a global
 *      any-marker check would let permuted anchors pass, because the
 *      export-default span contains every marker);
 *   3. rewritten-SITE recovery — the post-hoist call sites
 *      (`__cfLift_N(...)` / `__cfHandler_N(...)` applications and the
 *      `*WithPattern(__cfPattern_N, …)` enclosing calls) must recover to the
 *      SAME origin as their hoisted const, pinning the outer-call lineage the
 *      full-`preserveLineage` sites (lift-applied outer, mapWithPattern) and
 *      the capture-scaffold outer carry.
 * Recovery mirrors the probe's precedence (own position → own sourceMapRange →
 * original-chain terminal, `recoverAuthoredPosition` in `src/ast/utils.ts`);
 * CONTENT is the ground truth — a position pointing at the wrong text is still
 * broken lineage.
 *
 * The fourth check is CT-1870's consumer of that lineage: the module-scope
 * hardening stage annotates every function-bearing builder artifact with
 * `__cfBindVerifiedBinding(value, { … position, bindingName })`, and each
 * annotation's `position` must land on the authored function it names.
 *
 * Bite matrix (verified by reverting each fix file to its pre-fix state):
 * pattern-builder, capture-scaffold, array-method-transform and
 * schema-injection each individually FAIL this test when reverted. Known
 * boundary: rewrite-helpers' zero-input wrapper branch
 * (`createReactiveWrapperForExpression`'s non-input-bound path) is NOT
 * position-pinned here — a corpus-wide probe shows it firing for branch-root
 * shapes with non-destructured pattern input (e.g. jsx-direct-branch-roots'
 * `!state.task.done`), which resisted reproduction in this destructured-input
 * fixture; its preservations are kept §6a-symmetric and should get a direct
 * unit pin alongside CT-1870's injection acceptance.
 */

// One authored builder per origin path, each with a distinctive authored
// snippet so a recovered position can be matched back to where it was written:
//   ORIGIN-C  module-scope handler, applied in JSX   → in-place authored handler
//   ORIGIN-A  computed() with a capture              → LiftApplied → __cfLift
//   ORIGIN-N  computed() template for NAME           → LiftApplied → __cfLift
//   ORIGIN-B  inline reactive binary expr in JSX     → expression-site → __cfLift
//   ORIGIN-F  inline negation of a reactive property access in JSX →
//             zero-input reactive wrapper (rewrite-helpers' non-input-bound
//             branch) → __cfLift
//   ORIGIN-G  pattern-body binary over a dynamic opaque access → __cfLift
//   ORIGIN-E  inline captured action in JSX          → handler scaffold → __cfHandler
//   ORIGIN-D  .map with an element callback in JSX   → array-method → __cfPattern
//   ORIGIN-H  handler over a referenced arrow const  → in-place, anchor = const
//   ORIGIN-I  handler over a function declaration    → in-place, anchor = declaration
//   ORIGIN-J  handler over a property-access callback → in-place, anchor = the call
const FIXTURE = `import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface ProbeInput {
  count: number | Default<0>;
  flag: boolean | Default<false>;
  task: { done: boolean };
  label: string | Default<"probe">;
  items: string[] | Default<[]>;
}

// ORIGIN-C: authored module-scope handler
const bump = handler<unknown, { count: Writable<number> }>((_, state) => {
  state.count.set(state.count.get() + 1);
});

// ORIGIN-H: builder whose callback is a REFERENCED authored function
const onReset = (_: unknown, state: { count: Writable<number> }) => {
  state.count.set(0);
};
const reset = handler<unknown, { count: Writable<number> }>(onReset);

// ORIGIN-I: builder whose callback is a same-file FUNCTION DECLARATION,
// declared below its use (declarations hoist — mirrors the live
// generated-pattern form lift(sanitizeTickets)).
const zero = handler<unknown, { count: Writable<number> }>(onZero);
function onZero(_: unknown, state: { count: Writable<number> }) {
  state.count.set(0 * 1);
}

// ORIGIN-J: builder whose callback arrives through PROPERTY ACCESS — no
// same-file function anchors it, so the annotation anchors at the builder
// call itself.
const callbacks = {
  echoTick(_: unknown, state: { count: Writable<number> }) {
    state.count.set(state.count.get() + 10);
  },
};
const viaProperty = handler<unknown, { count: Writable<number> }>(callbacks.echoTick);

export default pattern<ProbeInput>(({ count, flag, label, items, task }) => {
  // ORIGIN-A: authored computed with a capture
  const doubled = computed(() => count * 2);
  // ORIGIN-G: binary over a dynamic opaque access — the zero-input wrapper
  const pick = items[count] + "!";
  return {
    // ORIGIN-N: authored computed template
    [NAME]: computed(() => \`probe \${label}\`),
    [UI]: (
      <div>
        {/* ORIGIN-B: inline reactive binary expression */}
        <span>{count * 3}</span>
        {/* ORIGIN-F: branch-root negation of a reactive property access */}
        <i>{flag || !task.done ? "on" : "off"}</i>
        <b>{doubled}</b>
        <em>{pick}</em>
        <ul>
          {/* ORIGIN-D: array map with element callback */}
          {items.map((item) => <li>{item}</li>)}
        </ul>
        <cf-button onClick={bump({ count })}>bump</cf-button>
        <cf-button onClick={reset({ count })}>reset</cf-button>
        <cf-button onClick={zero({ count })}>zero</cf-button>
        {/* ORIGIN-E: inline captured action */}
        <cf-button onClick={action(() => count * 4)}>quad</cf-button>
      </div>
    ),
    count,
    flag,
    label,
    items,
    task,
  };
});
`;

/**
 * The value a binding-identity annotation wraps, or the expression itself when
 * it carries none. The hardening stage annotates an EXPORTED artifact in place
 * (`export default __cfBindVerifiedBinding(pattern(…), { … })`), so the builder
 * call the lineage checks are about sits one level in.
 */
function unwrapBindingAnnotation(expression: ts.Expression): ts.Expression {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === BINDING_IDENTITY_HELPER_NAME
  ) {
    return expression.arguments[0]!;
  }
  return expression;
}

function findCallbackArgument(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return call.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
}

interface BuilderSite {
  readonly tag: string;
  /** The builder call whose authored position must be recoverable. For a
   * hoisted `const __cfLift_N = __cfHelpers.lift(...)` this is the INNER
   * call; for a top-level authored builder it is the call itself. */
  readonly call: ts.CallExpression;
  readonly callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
}

const HOISTED_NAME = /^__cf(Lift|Pattern|Handler)_\d+$/;

/**
 * Every hoisted builder-artifact const (`const __cf{Lift,Pattern,Handler}_N =
 * <builder call>`), every top-level authored builder const, and the
 * `export default <builder call>`. This is exactly the set
 * BuilderCallHoistingTransformer visits and that transform-time source
 * injection will read.
 */
function collectBuilderSites(root: ts.SourceFile): BuilderSite[] {
  const sites: BuilderSite[] = [];

  for (const stmt of root.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.initializer &&
          ts.isCallExpression(decl.initializer)
        ) {
          const name = decl.name.text;
          // Hoisted synthetics plus the authored module-scope `bump` handler.
          if (
            HOISTED_NAME.test(name) || name === "bump" || name === "reset" ||
            name === "zero" || name === "viaProperty"
          ) {
            sites.push({
              tag: name,
              call: decl.initializer,
              callback: findCallbackArgument(decl.initializer),
            });
          }
        }
      }
    }

    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      let expr = unwrapBindingAnnotation(stmt.expression);
      while (
        ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
        ts.isSatisfiesExpression(expr)
      ) {
        expr = expr.expression;
      }
      if (ts.isCallExpression(expr)) {
        sites.push({
          tag: "export-default",
          call: expr,
          callback: findCallbackArgument(expr),
        });
      }
    }
  }

  return sites;
}

/**
 * The rewritten post-hoist call SITES, keyed by the hoisted name they
 * reference: `__cfLift_N(captures)` / `__cfHandler_N(captures)` applications
 * (hoisted name as callee) and `receiver.*WithPattern(__cfPattern_N, …)`
 * enclosing calls (hoisted name in argument position). These are the nodes the
 * outer-call preservations (lift-applied outer, capture-scaffold outer,
 * mapWithPattern rebuild) exist for — a collector that only reads the hoisted
 * consts leaves those anchors unguarded (review finding on CT-1868).
 */
function collectRewrittenSites(
  root: ts.SourceFile,
): Map<string, ts.CallExpression> {
  const sites = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === BINDING_IDENTITY_HELPER_NAME
      ) {
        // A binding-identity annotation names its target but is not a rewritten
        // USE of it; it is checked separately, against its own metadata.
      } else if (
        ts.isIdentifier(node.expression) &&
        HOISTED_NAME.test(node.expression.text)
      ) {
        if (!sites.has(node.expression.text)) {
          sites.set(node.expression.text, node);
        }
      } else {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && HOISTED_NAME.test(arg.text)) {
            if (!sites.has(arg.text)) sites.set(arg.text, node);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return sites;
}

async function transformFixtureToAst(source = FIXTURE): Promise<{
  transformed: ts.SourceFile;
  /** The pre-transform source file, whose text the recovered positions index
   * into (it carries the `transformCfDirective` helper-import prelude). */
  original: ts.SourceFile;
}> {
  const fileName = "/ct1868-lineage-fixture.tsx";
  // Reuse the shared harness to build a program with the commonfabric + env
  // type definitions (and the `transformCfDirective` helper-import prelude).
  const { program } = await batchTypeCheckFixtures(
    { [fileName]: source },
    { types: COMMONFABRIC_TYPES },
  );
  const original = program.getSourceFile(fileName);
  assert(original, "fixture source file present in program");

  const pipeline = new CommonFabricTransformerPipeline();
  const result = ts.transform(original, pipeline.toFactories(program));
  const transformed = result.transformed[0];
  assert(transformed, "pipeline returned a transformed source file");
  // NB: do NOT dispose the result yet — disposal can clear the emit-node data
  // that holds sourceMapRange, which recoverAuthoredPosition reads.
  return { transformed, original };
}

/** The `position` / `bindingName` a binding-identity annotation reports. */
interface BindingAnnotation {
  readonly position: { line: number; col: number } | undefined;
  readonly bindingName: string | undefined;
}

function readNumericProperty(
  literal: ts.ObjectLiteralExpression,
  name: string,
): number | undefined {
  for (const property of literal.properties) {
    if (
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
      property.name.text === name &&
      ts.isNumericLiteral(property.initializer)
    ) {
      return Number(property.initializer.text);
    }
  }
  return undefined;
}

function readBindingAnnotation(metadata: ts.Expression): BindingAnnotation {
  assert(
    ts.isObjectLiteralExpression(metadata),
    "binding-identity metadata must be an object literal",
  );
  let position: { line: number; col: number } | undefined;
  let bindingName: string | undefined;
  for (const property of metadata.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      continue;
    }
    if (
      property.name.text === "position" &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      const line = readNumericProperty(property.initializer, "line");
      const col = readNumericProperty(property.initializer, "col");
      assert(
        line !== undefined && col !== undefined,
        "position must carry numeric line and col",
      );
      position = { line, col };
    }
    if (
      property.name.text === "bindingName" &&
      ts.isStringLiteral(property.initializer)
    ) {
      bindingName = property.initializer.text;
    }
  }
  return { position, bindingName };
}

/**
 * Every binding-identity annotation the hardening stage emitted, keyed the same
 * way {@link collectBuilderSites} keys artifacts: by the annotated binding's
 * name, and `export-default` for the annotated default export.
 */
function collectBindingAnnotations(
  root: ts.SourceFile,
): Map<string, BindingAnnotation> {
  const annotations = new Map<string, BindingAnnotation>();
  const isAnnotation = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === BINDING_IDENTITY_HELPER_NAME;

  for (const stmt of root.statements) {
    if (
      ts.isExpressionStatement(stmt) && isAnnotation(stmt.expression) &&
      ts.isIdentifier(stmt.expression.arguments[0]!)
    ) {
      annotations.set(
        (stmt.expression.arguments[0] as ts.Identifier).text,
        readBindingAnnotation(stmt.expression.arguments[1]!),
      );
    }
    if (
      ts.isExportAssignment(stmt) && !stmt.isExportEquals &&
      isAnnotation(stmt.expression)
    ) {
      annotations.set(
        "export-default",
        readBindingAnnotation(stmt.expression.arguments[1]!),
      );
    }
  }
  return annotations;
}

/** Distinctive authored markers for the hoisted-lift origins. Each hoisted
 * lift must claim exactly one, and collectively all must be claimed — the
 * per-tag binding a single global containment check cannot provide (the
 * export-default span contains all of them). */
const LIFT_MARKERS = [
  "count * 2", // ORIGIN-A
  "probe ${label}", // ORIGIN-N
  "count * 3", // ORIGIN-B
  "!task.done", // ORIGIN-F (zero-input wrapper route)
  'items[count] + "!"', // ORIGIN-G (pattern-body initializer)
];

/**
 * What each origin's annotation must report: the authored text its `position`
 * points at, and the authored binding name it was declared under. Keyed by the
 * origin's marker rather than by hoist name, because which `__cfLift_N` an
 * origin becomes is an ordering detail this fixture deliberately does not pin.
 * An entry with no `bindingName` was authored as an inline expression under no
 * declaration, and the annotation must omit the field.
 */
const ORIGIN_ANNOTATIONS = new Map<string, {
  anchor: string;
  bindingName?: string;
}>([
  ["count * 2", { anchor: "() => count * 2", bindingName: "doubled" }],
  ["probe ${label}", { anchor: "() => `probe ${label}`" }],
  ["count * 3", { anchor: "count * 3" }],
  ["!task.done", { anchor: "!task.done" }],
  [
    'items[count] + "!"',
    { anchor: 'items[count] + "!"', bindingName: "pick" },
  ],
  ["count * 4", { anchor: "() => count * 4" }], // ORIGIN-E, hoisted handler
  ["(item) =>", { anchor: "(item) => <li>{item}</li>" }], // ORIGIN-D
  ["state.count.set", { anchor: "(_, state) => {", bindingName: "bump" }],
  // ORIGIN-H: the annotation locates the REFERENCED callback where it was
  // written, named by its own declaration — not the builder binding.
  ["state.count.set(0)", {
    anchor: "(_: unknown, state: { count: Writable<number> }) => {",
    bindingName: "onReset",
  }],
  // ORIGIN-I: a declaration-form callback anchors at the declaration itself.
  ["state.count.set(0 * 1)", {
    anchor: "function onZero",
    bindingName: "onZero",
  }],
  // ORIGIN-J: no same-file function anchors a property-access callback, so
  // the annotation anchors at the builder call, named by its declaration.
  ["callbacks.echoTick", {
    anchor: "handler<unknown, { count: Writable<number> }>(callbacks.echoTick)",
    bindingName: "viaProperty",
  }],
  [
    "count, flag, label, items, task",
    { anchor: "({ count, flag, label, items, task }) => {" },
  ],
]);

Deno.test(
  "CT-1868: builder lineage recovers authored positions at the hoisting stage",
  async () => {
    const { transformed, original } = await transformFixtureToAst();
    const sourceText = original.text;

    const sites = collectBuilderSites(transformed);
    const rewritten = collectRewrittenSites(transformed);
    const annotations = collectBindingAnnotations(transformed);

    // Sanity: the fixture must actually exercise every origin path, or a
    // silent pipeline change (e.g. a builder no longer hoisting) would
    // vacuously pass.
    const tags = sites.map((s) => s.tag);
    assert(
      tags.filter((t) => t.startsWith("__cfLift_")).length >= 5,
      `expected >= 5 hoisted lifts (ORIGIN-A/N/B/F/G), got: ${tags.join(", ")}`,
    );
    assert(
      tags.some((t) => t.startsWith("__cfPattern_")),
      `expected a hoisted pattern (ORIGIN-D), got: ${tags.join(", ")}`,
    );
    assert(
      tags.some((t) => t.startsWith("__cfHandler_")),
      `expected a hoisted handler (ORIGIN-E inline action), got: ${
        tags.join(", ")
      }`,
    );
    assert(tags.includes("bump"), "expected the authored `bump` handler");
    assert(
      tags.includes("reset"),
      "expected the referenced-callback `reset` handler (ORIGIN-H)",
    );
    assert(
      tags.includes("zero"),
      "expected the declaration-callback `zero` handler (ORIGIN-I)",
    );
    assert(
      tags.includes("viaProperty"),
      "expected the property-access-callback `viaProperty` handler (ORIGIN-J)",
    );
    assert(
      tags.includes("export-default"),
      "expected the export-default pattern",
    );

    const recoveredByTag = new Map<string, string>();
    const recover = (tag: string, role: string, node: ts.Node): string => {
      const pos = recoverAuthoredPosition(node);
      assert(
        pos,
        `${tag} ${role}: reached the hoisting stage with no recoverable ` +
          `authored position (broken lineage)`,
      );
      return sourceText.slice(pos.pos, pos.end);
    };

    // 4. The emitted annotation for one origin: its `position` must address the
    // authored function it names, and `bindingName` must be the name that
    // function was declared under (or absent, for an inline expression).
    const checkAnnotation = (tag: string, marker: string): void => {
      const expected = ORIGIN_ANNOTATIONS.get(marker);
      assert(expected, `no annotation expectation for origin "${marker}"`);
      const annotation = annotations.get(tag);
      assert(annotation, `${tag}: the hardening stage emitted no annotation`);
      assert(
        annotation.position,
        `${tag}: annotation carries no authored position`,
      );
      const lineStarts = original.getLineStarts();
      assert(
        annotation.position.line >= 1 &&
          annotation.position.line <= lineStarts.length,
        `${tag}: annotation line ${annotation.position.line} is outside the ` +
          `authored file (${lineStarts.length} lines)`,
      );
      const offset = original.getPositionOfLineAndCharacter(
        annotation.position.line - 1,
        annotation.position.col,
      );
      const authored = sourceText.slice(
        offset,
        offset + expected.anchor.length,
      );
      assertEquals(
        authored,
        expected.anchor,
        `${tag}: annotation position ${annotation.position.line}:${annotation.position.col} ` +
          `addresses the wrong authored text`,
      );
      assertEquals(
        annotation.bindingName,
        expected.bindingName,
        `${tag}: annotation reports the wrong authored binding name`,
      );
    };

    // 1 + 2. Per-{tag, role} recovery AND per-tag content binding.
    const claimedLiftMarkers = new Map<string, string>();
    for (const site of sites) {
      const callText = recover(site.tag, "call", site.call);
      recoveredByTag.set(site.tag, callText);

      // ORIGIN-H's builder call carries its callback as an IDENTIFIER
      // (`handler(…, onReset)`) and ORIGIN-J's as a PROPERTY ACCESS, so there
      // is no function argument to recover here; their authored positions are
      // pinned through the annotation check.
      if (
        site.tag !== "export-default" && site.tag !== "reset" &&
        site.tag !== "zero" && site.tag !== "viaProperty"
      ) {
        assert(site.callback, `${site.tag}: expected a callback argument`);
      }
      const callbackText = site.callback
        ? recover(site.tag, "callback", site.callback)
        : undefined;

      if (site.tag.startsWith("__cfLift_")) {
        const markers = LIFT_MARKERS.filter((m) => callText.includes(m));
        assertEquals(
          markers.length,
          1,
          `${site.tag}: recovered call text must contain exactly one lift ` +
            `origin marker, got [${markers.join(", ")}] in: ${callText}`,
        );
        const marker = markers[0]!;
        assert(
          !claimedLiftMarkers.has(marker),
          `${site.tag}: origin marker "${marker}" already claimed by ${
            claimedLiftMarkers.get(marker)
          } — permuted anchors`,
        );
        claimedLiftMarkers.set(marker, site.tag);
        if (callbackText !== undefined) {
          assert(
            callbackText.includes(marker),
            `${site.tag} callback: recovered text should carry the same ` +
              `origin marker "${marker}", got: ${callbackText}`,
          );
        }
        checkAnnotation(site.tag, marker);
      } else if (site.tag.startsWith("__cfHandler_")) {
        assert(
          callText.includes("count * 4"),
          `${site.tag}: expected the ORIGIN-E action body, got: ${callText}`,
        );
        checkAnnotation(site.tag, "count * 4");
      } else if (site.tag.startsWith("__cfPattern_")) {
        assert(
          callText.includes("(item) =>"),
          `${site.tag}: expected the ORIGIN-D map callback, got: ${callText}`,
        );
        checkAnnotation(site.tag, "(item) =>");
      } else if (site.tag === "zero") {
        checkAnnotation(site.tag, "state.count.set(0 * 1)");
      } else if (site.tag === "viaProperty") {
        assert(
          callText.includes("callbacks.echoTick"),
          `viaProperty: expected the property-access callback call, got: ${callText}`,
        );
        checkAnnotation(site.tag, "callbacks.echoTick");
      } else if (site.tag === "reset") {
        assert(
          callbackText === undefined ||
            callbackText.includes("state.count.set(0)"),
          `reset callback recovery: ${callbackText}`,
        );
        checkAnnotation(site.tag, "state.count.set(0)");
      } else if (site.tag === "bump") {
        assert(
          callbackText !== undefined &&
            callbackText.includes("state.count.set"),
          `bump callback: expected the authored handler body, got: ${callbackText}`,
        );
        checkAnnotation(site.tag, "state.count.set");
      } else if (site.tag === "export-default") {
        assert(
          callText.includes("count, flag, label, items, task"),
          `export-default: expected the authored pattern call, got: ${callText}`,
        );
        checkAnnotation(site.tag, "count, flag, label, items, task");
      }
    }
    assertEquals(
      annotations.size,
      sites.length,
      `every builder artifact must carry exactly one binding-identity ` +
        `annotation; annotated: ${[...annotations.keys()].join(", ")}`,
    );
    assertEquals(
      claimedLiftMarkers.size,
      LIFT_MARKERS.length,
      `every lift origin must be claimed by exactly one hoist; claimed: ${
        [...claimedLiftMarkers.keys()].join(", ")
      }`,
    );

    // 3. Rewritten post-hoist SITES: each must recover, and to the SAME
    // origin as its hoisted const.
    for (const site of sites) {
      if (!HOISTED_NAME.test(site.tag)) continue;
      const siteCall = rewritten.get(site.tag);
      assert(
        siteCall,
        `${site.tag}: no rewritten call site found referencing the hoist`,
      );
      const siteText = recover(`site:${site.tag}`, "call", siteCall);
      const hoistText = recoveredByTag.get(site.tag)!;
      const sharedMarker = [...LIFT_MARKERS, "count * 4", "(item) =>"].find(
        (m) => hoistText.includes(m),
      );
      assert(sharedMarker, `${site.tag}: hoist text carries no known marker`);
      assert(
        siteText.includes(sharedMarker),
        `site:${site.tag}: rewritten site recovered to a different origin ` +
          `than its hoist (expected marker "${sharedMarker}"), got: ${siteText}`,
      );
    }
  },
);

// A pattern authored as a NAMED module-scope const, whose body lifts an inline
// JSX expression. The const's own artifact is named `named`; the lift hoisted
// out of its body was authored under no declaration and must stay anonymous —
// the declaration a pattern is assigned to does not name what is written inside
// its callback.
const NAMED_PATTERN_FIXTURE = `import {
  Default,
  pattern,
  UI,
} from "commonfabric";

interface Input {
  count: number | Default<0>;
}

const named = pattern<Input>(({ count }) => ({
  [UI]: <span>{count + 7}</span>,
}));

export default named;
`;

Deno.test(
  "CT-1870: an inline lift inside a named pattern const stays anonymous",
  async () => {
    const { transformed } = await transformFixtureToAst(NAMED_PATTERN_FIXTURE);
    const annotations = collectBindingAnnotations(transformed);

    assertEquals(
      annotations.get("named")?.bindingName,
      "named",
      `the pattern const's own artifact is named after its declaration; ` +
        `annotated: ${[...annotations.keys()].join(", ")}`,
    );

    const lifts = [...annotations].filter(([tag]) => HOISTED_NAME.test(tag));
    assertEquals(
      lifts.length,
      1,
      `expected the inline JSX expression to hoist to one lift, got: ${
        lifts.map(([tag]) => tag).join(", ")
      }`,
    );
    assertEquals(
      lifts[0]![1].bindingName,
      undefined,
      `a lift hoisted out of the pattern callback carries no authored name`,
    );
  },
);
