import ts from "typescript";
import { assert } from "@std/assert";
import { CommonFabricTransformerPipeline } from "../src/mod.ts";
import { batchTypeCheckFixtures } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * CT-1868 lineage regression — the hermetic, tracked form of the transform-time
 * lineage probe documented in `APRIME-LINEAGE-HANDOFF.md` §3/§11.
 *
 * The transformer pipeline must arrive at BuilderCallHoisting (stage 14) with
 * every hoisted / authored builder call — its inner call AND its callback —
 * still carrying a recoverable AUTHORED source position. Before the fix these
 * arrived bare (`pos: -1`, no sourceMapRange, no original chain), so transform-
 * time / debug source resolution had nothing to read. The fix carries lineage
 * across the closure strategies, the expression-rewrite emitters and the
 * SchemaInjection rebuilds (see `preserveLineage` / `preserveSourceMapRange` and
 * the SchemaInjection `create → update*` conversions).
 *
 * This drives the REAL pipeline over a five-origin fixture, then walks the
 * transformed AST for the hoisted `__cf{Lift,Pattern,Handler}_N` consts and the
 * top-level authored builders, asserting each recovers to the correct authored
 * snippet. Recovery mirrors the probe's precedence (own position → own
 * sourceMapRange → original-chain terminal); CONTENT is the ground truth — a
 * position pointing at the wrong text is still broken lineage.
 */

// One authored builder per origin path, each with a distinctive authored
// snippet so a recovered position can be matched back to where it was written:
//   ORIGIN-C  module-scope handler, applied in JSX   → in-place authored handler
//   ORIGIN-A  computed() with a capture              → LiftApplied → __cfLift
//   ORIGIN-N  computed() template for NAME           → LiftApplied → __cfLift
//   ORIGIN-B  inline reactive binary expr in JSX     → expression-site → __cfLift
//   ORIGIN-D  .map with an element callback in JSX   → array-method → __cfPattern
const FIXTURE = `import {
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
  label: string | Default<"probe">;
  items: string[] | Default<[]>;
}

// ORIGIN-C: authored module-scope handler
const bump = handler<unknown, { count: Writable<number> }>((_, state) => {
  state.count.set(state.count.get() + 1);
});

export default pattern<ProbeInput>(({ count, label, items }) => {
  // ORIGIN-A: authored computed with a capture
  const doubled = computed(() => count * 2);
  return {
    // ORIGIN-N: authored computed template
    [NAME]: computed(() => \`probe \${label}\`),
    [UI]: (
      <div>
        {/* ORIGIN-B: inline reactive binary expression */}
        <span>{count * 3}</span>
        <b>{doubled}</b>
        <ul>
          {/* ORIGIN-D: array map with element callback */}
          {items.map((item) => <li>{item}</li>)}
        </ul>
        <cf-button onClick={bump({ count })}>bump</cf-button>
      </div>
    ),
    count,
    label,
    items,
  };
});
`;

/**
 * Best-available authored position for a (possibly synthetic) node, mirroring
 * the probe's recovery precedence: the node's own text range, else its explicit
 * sourceMapRange, else the terminal of its original-node chain. Returns
 * undefined when none of the three yields a real (`>= 0`) position — i.e. broken
 * lineage.
 */
function recoverPosition(
  node: ts.Node,
): { pos: number; end: number } | undefined {
  if (node.pos >= 0) return { pos: node.pos, end: node.end };

  // ts.getSourceMapRange returns the node itself when no explicit range is set.
  const smr = ts.getSourceMapRange(node);
  if ((smr as unknown) !== (node as unknown) && smr.pos >= 0) {
    return { pos: smr.pos, end: smr.end };
  }

  const original = ts.getOriginalNode(node);
  if (original !== node && original.pos >= 0) {
    return { pos: original.pos, end: original.end };
  }
  return undefined;
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
   * hoisted `const __cfLift_N = __cfHelpers.lift(...)` this is the INNER lift
   * call; for a top-level authored builder it is the call itself. */
  readonly call: ts.CallExpression;
  readonly callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
}

/**
 * Every hoisted builder-artifact const (`const __cf{Lift,Pattern,Handler}_N =
 * <builder call>`), every top-level authored builder const, and the
 * `export default <builder call>`. This is exactly the set
 * BuilderCallHoistingTransformer visits and that transform-time source
 * injection will read.
 */
function collectBuilderSites(root: ts.SourceFile): BuilderSite[] {
  const sites: BuilderSite[] = [];
  const hoistedName = /^__cf(Lift|Pattern|Handler)_\d+$/;

  for (const stmt of root.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.initializer &&
          ts.isCallExpression(decl.initializer)
        ) {
          const name = decl.name.text;
          // Hoisted synthetics plus the authored module-scope `bump` handler.
          if (hoistedName.test(name) || name === "bump") {
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
      let expr = stmt.expression;
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

async function transformFixtureToAst(): Promise<{
  transformed: ts.SourceFile;
  /** The pre-transform source file, whose text the recovered positions index
   * into (it carries the `transformCfDirective` helper-import prelude). */
  original: ts.SourceFile;
}> {
  const fileName = "/ct1868-lineage-fixture.tsx";
  // Reuse the shared harness to build a program with the commonfabric + env
  // type definitions (and the `transformCfDirective` helper-import prelude).
  const { program } = await batchTypeCheckFixtures(
    { [fileName]: FIXTURE },
    { types: COMMONFABRIC_TYPES },
  );
  const original = program.getSourceFile(fileName);
  assert(original, "fixture source file present in program");

  const pipeline = new CommonFabricTransformerPipeline({ mode: "transform" });
  const result = ts.transform(original, pipeline.toFactories(program));
  const transformed = result.transformed[0];
  assert(transformed, "pipeline returned a transformed source file");
  // NB: do NOT dispose the result yet — disposal can clear the emit-node data
  // that holds sourceMapRange, which recoverPosition reads.
  return { transformed, original };
}

Deno.test(
  "CT-1868: builder lineage recovers authored positions at the hoisting stage",
  async () => {
    const { transformed, original } = await transformFixtureToAst();
    const sourceText = original.text;

    const sites = collectBuilderSites(transformed);

    // Sanity: the fixture must actually exercise every origin path, or a silent
    // pipeline change (e.g. a builder no longer hoisting) would vacuously pass.
    const tags = sites.map((s) => s.tag);
    assert(
      tags.filter((t) => t.startsWith("__cfLift_")).length >= 3,
      `expected >= 3 hoisted lifts (ORIGIN-A/N/B), got: ${tags.join(", ")}`,
    );
    assert(
      tags.some((t) => t.startsWith("__cfPattern_")),
      `expected a hoisted pattern (ORIGIN-D), got: ${tags.join(", ")}`,
    );
    assert(tags.includes("bump"), "expected the authored `bump` handler");
    assert(
      tags.includes("export-default"),
      "expected the export-default pattern",
    );

    // Every builder call AND its callback must recover an authored position.
    const recoveredSnippets: string[] = [];
    for (const site of sites) {
      const callPos = recoverPosition(site.call);
      assert(
        callPos,
        `${site.tag}: builder call reached the hoisting stage with no ` +
          `recoverable authored position (broken lineage)`,
      );
      recoveredSnippets.push(sourceText.slice(callPos.pos, callPos.end));

      assert(site.callback, `${site.tag}: expected a callback argument`);
      const callbackPos = recoverPosition(site.callback);
      assert(
        callbackPos,
        `${site.tag}: callback reached the hoisting stage with no ` +
          `recoverable authored position (broken lineage)`,
      );
      recoveredSnippets.push(
        sourceText.slice(callbackPos.pos, callbackPos.end),
      );
    }

    // Content is the ground truth: the recovered positions must collectively
    // cover every authored origin's distinctive snippet. A `pos >= 0` pointing
    // at the wrong text would pass the per-site checks above but fail here.
    const recoveredText = recoveredSnippets.join("\n");
    const originMarkers = [
      "count * 2", // ORIGIN-A
      "probe ${label}", // ORIGIN-N
      "count * 3", // ORIGIN-B
      "(item) =>", // ORIGIN-D (.map element callback)
      "state.count.set", // ORIGIN-C (bump handler body)
      "count, label, items", // export-default pattern callback
    ];
    for (const marker of originMarkers) {
      assert(
        recoveredText.includes(marker),
        `no recovered builder position covers authored origin ${
          JSON.stringify(marker)
        }.\nRecovered snippets:\n${recoveredText}`,
      );
    }
  },
);
