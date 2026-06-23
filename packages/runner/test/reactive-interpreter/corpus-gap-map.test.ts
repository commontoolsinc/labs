/**
 * CORPUS DIFFERENTIAL gap-map — honest coverage measurement of the Reactive
 * Interpreter against REAL (builder-produced) patterns.
 *
 * This is a MEASUREMENT, not a gate. It builds a set of representative patterns
 * (plain leaf, nested access, ifElse/when/unless, str, map, filter, flatMap,
 * nested pattern, handler/effect, multi-level composite) via the trusted builder
 * and, for each, ATTEMPTS the full interpreter path:
 *
 *   extractRog(pattern) -> resolveLeafImpls(pattern, rog) -> evalRog(...)
 *      (or, for collections, the buildElementEvaluator element path)
 *
 * and compares the interpreter result to the LEGACY `runtime.run` result. Each
 * pattern records one of:
 *   - MATCH      : interpreter ran AND equals legacy.
 *   - DIVERGE    : interpreter ran but the value differs from legacy.
 *   - UNHANDLED  : interpreter threw (NotInterpretedHere / no leaf impl /
 *                  unresolved leaves) or its extraction dropped the result —
 *                  the reason is recorded verbatim.
 *
 * The point is the gap-map: most rows are expected UNHANDLED today. The test
 * asserts only that the harness runs and produces the coverage table — it does
 * NOT assert hard parity over the set (that would be a gate, not a measurement).
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/corpus-gap-map.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import {
  createMeasureEnv,
  type MeasureEnv,
} from "../support/interpreter-measure.ts";
import {
  type ExtractResult,
  extractRog,
  resolveLeafImpls,
} from "../../src/reactive-interpreter/extract.ts";
import { evalRog } from "../../src/reactive-interpreter/interpret.ts";
import { buildElementEvaluator } from "../../src/reactive-interpreter/element-evaluator.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-corpus-gap-map");
const num = { type: "number" } as const satisfies JSONSchema;
const str = { type: "string" } as const satisfies JSONSchema;
const bool = { type: "boolean" } as const satisfies JSONSchema;

// ---------------------------------------------------------------------------
// Result classification.
// ---------------------------------------------------------------------------

type Status = "MATCH" | "DIVERGE" | "UNHANDLED";

interface Row {
  name: string;
  /** Feature(s) the pattern exercises (for the gap backlog grouping). */
  feature: string;
  status: Status;
  /** For DIVERGE/UNHANDLED: the reason / both values. Empty for MATCH. */
  reason: string;
  /** Coverage report numbers (extraction view), when extraction ran. */
  cov?: { nodes: number; nested: number; byKind: Record<string, number> };
}

/**
 * Value parity at the JSON level: round-trip both sides through JSON so that
 * `undefined`-valued keys collapse to absent (JSON semantics — the runtime
 * persists no value for them) and non-string symbol keys like `[UI]` drop out.
 * This compares the DATA the two paths produce, which is the honest oracle —
 * a genuine value disagreement still surfaces as DIVERGE.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    try {
      return JSON.stringify(v ?? null);
    } catch {
      return String(v);
    }
  };
  return norm(a) === norm(b);
}

function brief(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Per-pattern probe. Each `build` returns a freshly-built pattern (the
// in-memory factory result) plus the legacy argument to run it with. The
// `collection` flag routes the interpreter through buildElementEvaluator over
// the element pattern when the top-level interpreter can't run the whole graph.
// ---------------------------------------------------------------------------

interface Spec {
  name: string;
  feature: string;
  // deno-lint-ignore no-explicit-any
  build: (cf: any) => { pattern: any; arg: unknown; resultSchema: JSONSchema };
}

/**
 * Run a built pattern through legacy `runtime.run` and read the result. When
 * `collectionField` is given, the result field holds a collection (cell links to
 * per-element docs) that only materializes when read via `.key(field)` and
 * pulled — the whole-object `.pull()` returns `{}` for those (the dedicated
 * collection-interpret.test.ts reads `result.key("mapped")` for the same reason).
 */
async function legacyRun(
  env: MeasureEnv,
  // deno-lint-ignore no-explicit-any
  pattern: any,
  arg: unknown,
  resultSchema: JSONSchema,
  cause: string,
  collectionField?: string,
): Promise<unknown> {
  const { runtime, space } = env;
  const tx = runtime.edit();
  const res = runtime.getCell(space, cause, resultSchema, tx);
  const r = runtime.run(tx, pattern, arg, res);
  await tx.commit();
  await runtime.idle();
  if (collectionField) {
    // deno-lint-ignore no-explicit-any
    const field = (r as any).key(collectionField);
    field.sink(() => {});
    await runtime.idle();
    return await field.pull();
  }
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

/**
 * Attempt the interpreter on a top-level (non-collection) pattern:
 * extractRog -> resolveLeafImpls -> evalRog. Returns either the value or an
 * UNHANDLED reason. Throws are converted to reasons (the honest boundary).
 */
function tryInterpretTopLevel(
  // deno-lint-ignore no-explicit-any
  pattern: any,
  arg: unknown,
): { ok: true; value: unknown; ex: ExtractResult } | {
  ok: false;
  reason: string;
  ex?: ExtractResult;
} {
  let ex: ExtractResult;
  try {
    ex = extractRog(pattern);
  } catch (e) {
    return { ok: false, reason: `extractRog threw: ${(e as Error).message}` };
  }
  let leafImpls;
  let unresolvedLeafOps;
  try {
    ({ leafImpls, unresolvedLeafOps } = resolveLeafImpls(pattern, ex.rog));
  } catch (e) {
    return {
      ok: false,
      reason: `resolveLeafImpls threw: ${(e as Error).message}`,
      ex,
    };
  }
  if (unresolvedLeafOps.length > 0) {
    return {
      ok: false,
      reason: `unresolved leaf ops ${JSON.stringify(unresolvedLeafOps)} ` +
        `(serialized/SES boundary or non-callable module.implementation)`,
      ex,
    };
  }
  try {
    const { result } = evalRog(ex.rog, {
      argument: arg,
      leafImpls,
      internalToOp: ex.internalToOp,
    });
    return { ok: true, value: result, ex };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      reason: `evalRog threw: ${err.name}: ${err.message}`,
      ex,
    };
  }
}

/**
 * Attempt the interpreter on a COLLECTION pattern via the element path. The
 * top-level pattern result is `{ <field>: <list>.mapWithPattern(elementPattern) }`;
 * the collection op is NOT interpreted by evalRog (it throws NotInterpretedHere),
 * so the corpus probe exercises the actual W3 seam: extract the element pattern
 * from the collection node's `op` input and run `buildElementEvaluator` over the
 * input list, assembling the mapped/filtered/flat result the same way the W3
 * coordinator does. This is the real interpreter collection path applied to a
 * builder-produced element pattern (in-memory leaves resolve directly).
 */
function tryInterpretCollection(
  // deno-lint-ignore no-explicit-any
  pattern: any,
  arg: unknown,
  collKind: "map" | "filter" | "flatMap",
  listField: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  // Find the collection node in the built pattern and pull its element `op`.
  // deno-lint-ignore no-explicit-any
  const nodes = (pattern.nodes ?? []) as any[];
  const collNode = nodes.find((n) => {
    const impl = n?.module?.implementation;
    return impl === collKind;
  });
  if (!collNode) {
    return { ok: false, reason: `no ${collKind} node found in built pattern` };
  }
  const elementPattern = collNode.inputs?.op;
  if (!elementPattern || !Array.isArray(elementPattern.nodes)) {
    return {
      ok: false,
      reason: `${collKind} element op is not an inline Pattern (got ${
        brief(elementPattern && Object.keys(elementPattern))
      }) — serialized $patternRef path needs the SES index`,
    };
  }
  let evaluate;
  try {
    evaluate = buildElementEvaluator(elementPattern);
  } catch (e) {
    return {
      ok: false,
      reason: `buildElementEvaluator threw: ${(e as Error).message}`,
    };
  }
  if (evaluate.unresolvedLeafOps.length > 0) {
    return {
      ok: false,
      reason: `element-evaluator unresolved leaf ops ${
        JSON.stringify([...evaluate.unresolvedLeafOps])
      }`,
    };
  }
  const list = (arg as Record<string, unknown>)[listField] as unknown[];
  if (!Array.isArray(list)) {
    return { ok: false, reason: `arg.${listField} is not an array` };
  }
  try {
    const mapped = list.map((el) => evaluate(el));
    let value: unknown;
    if (collKind === "map") value = mapped;
    else if (collKind === "filter") {
      value = list.filter((_, i) => Boolean(mapped[i]));
    } else value = (mapped as unknown[]).flat();
    return { ok: true, value };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      reason: `element eval threw: ${err.name}: ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The corpus. Each spec is a representative, real-ish pattern built with the
// real builder.
// ---------------------------------------------------------------------------

const SPECS: Spec[] = [
  {
    name: "plain leaf: ({x}) => ({y: double(x)})",
    feature: "leaf",
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      return {
        pattern: cf.pattern(
          ({ x }: { x: number }) => ({ y: double(x) }),
          { type: "object", properties: { x: num }, required: ["x"] },
          { type: "object", properties: { y: num } },
        ),
        arg: { x: 21 },
        resultSchema: { type: "object", properties: { y: num } },
      };
    },
  },
  {
    name: "nested access: ({user}) => ({next: inc(user.age)})",
    feature: "access (nested arg path)",
    build: (cf) => {
      const inc = cf.lift((x: number) => x + 1, num, num);
      return {
        pattern: cf.pattern(
          ({ user }: { user: { age: number } }) => ({ next: inc(user.age) }),
          {
            type: "object",
            properties: {
              user: { type: "object", properties: { age: num } },
            },
            required: ["user"],
          },
          { type: "object", properties: { next: num } },
        ),
        arg: { user: { age: 40 } },
        resultSchema: { type: "object", properties: { next: num } },
      };
    },
  },
  {
    name: "ifElse: ({x,show}) => ({shown: ifElse(show,x,0)})",
    feature: "control: ifElse",
    build: (cf) => ({
      pattern: cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          shown: cf.ifElse(show, x, 0),
        }),
        {
          type: "object",
          properties: { x: num, show: bool },
          required: ["x", "show"],
        },
        { type: "object", properties: { shown: num } },
      ),
      arg: { x: 7, show: true },
      resultSchema: { type: "object", properties: { shown: num } },
    }),
  },
  {
    name: "when: ({x,show}) => ({maybe: when(show, x)})",
    feature: "control: when",
    build: (cf) => ({
      pattern: cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          maybe: cf.when(show, x),
        }),
        {
          type: "object",
          properties: { x: num, show: bool },
          required: ["x", "show"],
        },
        { type: "object", properties: { maybe: num } },
      ),
      arg: { x: 9, show: false },
      resultSchema: { type: "object", properties: { maybe: num } },
    }),
  },
  {
    name: "unless: ({x,hide}) => ({maybe: unless(hide, x)})",
    feature: "control: unless",
    build: (cf) => ({
      pattern: cf.pattern(
        ({ x, hide }: { x: number; hide: boolean }) => ({
          maybe: cf.unless(hide, x),
        }),
        {
          type: "object",
          properties: { x: num, hide: bool },
          required: ["x", "hide"],
        },
        { type: "object", properties: { maybe: num } },
      ),
      arg: { x: 5, hide: false },
      resultSchema: { type: "object", properties: { maybe: num } },
    }),
  },
  {
    name: "str: ({name}) => ({greeting: str`Hello ${name}`})",
    feature: "builtin: str (template)",
    build: (cf) => ({
      pattern: cf.pattern(
        ({ name }: { name: string }) => ({
          greeting: cf.str`Hello ${name}`,
        }),
        { type: "object", properties: { name: str }, required: ["name"] },
        { type: "object", properties: { greeting: str } },
      ),
      arg: { name: "Ada" },
      resultSchema: { type: "object", properties: { greeting: str } },
    }),
  },
  {
    name: "two-op composite: ({x,show}) => ({doubled, shown})",
    feature: "leaf + control + construct",
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      return {
        pattern: cf.pattern(
          ({ x, show }: { x: number; show: boolean }) => ({
            doubled: double(x),
            shown: cf.ifElse(show, x, 0),
          }),
          {
            type: "object",
            properties: { x: num, show: bool },
            required: ["x", "show"],
          },
          { type: "object", properties: { doubled: num, shown: num } },
        ),
        arg: { x: 21, show: true },
        resultSchema: {
          type: "object",
          properties: { doubled: num, shown: num },
        },
      };
    },
  },
  {
    name: "chained leaves: ({x}) => ({y: double(inc(x))})",
    feature: "leaf -> leaf (internal->opOut wiring)",
    build: (cf) => {
      const inc = cf.lift((x: number) => x + 1, num, num);
      const double = cf.lift((x: number) => x * 2, num, num);
      return {
        pattern: cf.pattern(
          ({ x }: { x: number }) => ({ y: double(inc(x)) }),
          { type: "object", properties: { x: num }, required: ["x"] },
          { type: "object", properties: { y: num } },
        ),
        arg: { x: 10 },
        resultSchema: { type: "object", properties: { y: num } },
      };
    },
  },
  {
    name: "map: ({values}) => ({mapped: values.map(double)})",
    feature: "collection: map",
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      const elementPattern = cf.pattern(
        ({ element }: { element: number }) => double(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        num,
      );
      return {
        pattern: cf.pattern(
          ({ values }: { values: number[] }) => ({
            mapped: (values as unknown as {
              mapWithPattern: (op: unknown, opts: unknown) => unknown;
            }).mapWithPattern(elementPattern, {}),
          }),
          {
            type: "object",
            properties: { values: { type: "array", items: num } },
            required: ["values"],
          },
          {
            type: "object",
            properties: { mapped: { type: "array", items: num } },
          },
        ),
        arg: { values: [1, 2, 3] },
        resultSchema: {
          type: "object",
          properties: { mapped: { type: "array", items: num } },
        },
      };
    },
  },
  {
    name: "filter: ({values}) => ({kept: values.filter(isEven)})",
    feature: "collection: filter",
    build: (cf) => {
      const isEven = cf.lift((x: number) => x % 2 === 0, num, bool);
      const elementPattern = cf.pattern(
        ({ element }: { element: number }) => isEven(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        bool,
      );
      return {
        pattern: cf.pattern(
          ({ values }: { values: number[] }) => ({
            kept: (values as unknown as {
              filterWithPattern: (op: unknown, opts: unknown) => unknown;
            }).filterWithPattern(elementPattern, {}),
          }),
          {
            type: "object",
            properties: { values: { type: "array", items: num } },
            required: ["values"],
          },
          {
            type: "object",
            properties: { kept: { type: "array", items: num } },
          },
        ),
        arg: { values: [1, 2, 3, 4] },
        resultSchema: {
          type: "object",
          properties: { kept: { type: "array", items: num } },
        },
      };
    },
  },
  {
    name: "flatMap: ({values}) => ({out: values.flatMap(pair)})",
    feature: "collection: flatMap",
    build: (cf) => {
      const pair = cf.lift((x: number) => [x, x], num, {
        type: "array",
        items: num,
      });
      const elementPattern = cf.pattern(
        ({ element }: { element: number }) => pair(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        { type: "array", items: num },
      );
      return {
        pattern: cf.pattern(
          ({ values }: { values: number[] }) => ({
            out: (values as unknown as {
              flatMapWithPattern: (op: unknown, opts: unknown) => unknown;
            }).flatMapWithPattern(elementPattern, {}),
          }),
          {
            type: "object",
            properties: { values: { type: "array", items: num } },
            required: ["values"],
          },
          {
            type: "object",
            properties: { out: { type: "array", items: num } },
          },
        ),
        arg: { values: [1, 2] },
        resultSchema: {
          type: "object",
          properties: { out: { type: "array", items: num } },
        },
      };
    },
  },
  {
    name: "nested pattern: ({x}) => ({inner: child({v:x})})",
    feature: "nested pattern composition",
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      const child = cf.pattern(
        ({ v }: { v: number }) => ({ doubled: double(v) }),
        { type: "object", properties: { v: num }, required: ["v"] },
        { type: "object", properties: { doubled: num } },
      );
      return {
        pattern: cf.pattern(
          ({ x }: { x: number }) => ({ inner: child({ v: x }) }),
          { type: "object", properties: { x: num }, required: ["x"] },
          {
            type: "object",
            properties: {
              inner: { type: "object", properties: { doubled: num } },
            },
          },
        ),
        arg: { x: 6 },
        resultSchema: {
          type: "object",
          properties: {
            inner: { type: "object", properties: { doubled: num } },
          },
        },
      };
    },
  },
  {
    name: "handler/effect: ({count}) => ({count, increment: handler})",
    feature: "effect: handler (event stream)",
    build: (cf) => {
      const increment = cf.handler(
        {},
        { type: "object", properties: { count: num } },
        (_ev: unknown, state: { count: number }) => {
          state.count = (state.count ?? 0) + 1;
        },
      );
      return {
        pattern: cf.pattern(
          ({ count }: { count: number }) => ({
            count,
            increment: increment({ count }),
          }),
          { type: "object", properties: { count: num }, required: ["count"] },
          {
            type: "object",
            properties: { count: num, increment: { asStream: true } },
          },
        ),
        arg: { count: 0 },
        resultSchema: { type: "object", properties: { count: num } },
      };
    },
  },
  {
    name: "UI render: ({label}) => ({[UI]: <div>{label}</div>})",
    feature: "effect: render (UI / h)",
    build: (cf) => ({
      pattern: cf.pattern(
        ({ label }: { label: string }) => ({
          label,
          [cf.UI]: cf.h("div", {}, label),
        }),
        { type: "object", properties: { label: str }, required: ["label"] },
        { type: "object", properties: { label: str } },
      ),
      arg: { label: "hi" },
      resultSchema: { type: "object", properties: { label: str } },
    }),
  },
  {
    name: "2-level composite: ({x,show}) => ({inner: child(...), shown})",
    feature: "nested pattern + control + leaf (multi-level)",
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      const child = cf.pattern(
        ({ v }: { v: number }) => ({ doubled: double(v) }),
        { type: "object", properties: { v: num }, required: ["v"] },
        { type: "object", properties: { doubled: num } },
      );
      return {
        pattern: cf.pattern(
          ({ x, show }: { x: number; show: boolean }) => ({
            inner: child({ v: x }),
            shown: cf.ifElse(show, x, 0),
          }),
          {
            type: "object",
            properties: { x: num, show: bool },
            required: ["x", "show"],
          },
          {
            type: "object",
            properties: {
              inner: { type: "object", properties: { doubled: num } },
              shown: num,
            },
          },
        ),
        arg: { x: 8, show: true },
        resultSchema: {
          type: "object",
          properties: {
            inner: { type: "object", properties: { doubled: num } },
            shown: num,
          },
        },
      };
    },
  },
];

/** Collection specs route through the element-evaluator path. `field` is the
 * argument list field; `resultField` is the output field holding the collection
 * (read via `.key(resultField)` so legacy materializes the element links). */
const COLLECTION: Record<
  string,
  {
    kind: "map" | "filter" | "flatMap";
    field: string;
    resultField: string;
    /** Independent ground truth, used when the generic legacy harness cannot
     * materialize the collection from a plain-array arg (it returns undefined —
     * a legacy-harness limitation, not an interpreter gap). */
    groundTruth: unknown;
  }
> = {
  "map: ({values}) => ({mapped: values.map(double)})": {
    kind: "map",
    field: "values",
    resultField: "mapped",
    groundTruth: [2, 4, 6],
  },
  "filter: ({values}) => ({kept: values.filter(isEven)})": {
    kind: "filter",
    field: "values",
    resultField: "kept",
    groundTruth: [2, 4],
  },
  "flatMap: ({values}) => ({out: values.flatMap(pair)})": {
    kind: "flatMap",
    field: "values",
    resultField: "out",
    groundTruth: [1, 1, 2, 2],
  },
};

// ---------------------------------------------------------------------------
// The measurement.
// ---------------------------------------------------------------------------

describe("Reactive Interpreter — corpus differential gap-map", () => {
  it("builds the coverage table over a representative corpus (measurement, not a gate)", async () => {
    const rows: Row[] = [];

    for (let i = 0; i < SPECS.length; i++) {
      const spec = SPECS[i];
      // Fresh env per pattern so leaked scheduler state / disposed runtimes
      // never cross-contaminate a row's legacy run.
      const env = createMeasureEnv(signer);
      try {
        // deno-lint-ignore no-explicit-any
        const cf = env.commonfabric as any;
        const { pattern, arg, resultSchema } = spec.build(cf);

        const coll = COLLECTION[spec.name];

        // Legacy ground truth (may itself fail for some shapes; record it). For
        // collection rows read the inner field (the array), so the oracle lines
        // up with the interpreter's element-evaluated array.
        let legacyOut: unknown;
        let legacyError: string | undefined;
        try {
          legacyOut = await legacyRun(
            env,
            pattern,
            arg,
            resultSchema,
            `corpus:${i}`,
            coll?.resultField,
          );
        } catch (e) {
          legacyError = (e as Error).message;
        }

        // Interpreter attempt.
        let interp:
          | { ok: true; value: unknown; ex?: ExtractResult }
          | { ok: false; reason: string; ex?: ExtractResult };
        if (coll) {
          interp = tryInterpretCollection(pattern, arg, coll.kind, coll.field);
          // Also record the top-level extraction coverage for the table.
          try {
            interp = { ...interp, ex: extractRog(pattern) } as typeof interp;
          } catch { /* ignore */ }
        } else {
          interp = tryInterpretTopLevel(pattern, arg);
        }

        const cov = interp.ex
          ? {
            nodes: interp.ex.coverage.nodes,
            nested: interp.ex.coverage.nested,
            byKind: interp.ex.coverage.byKind as Record<string, number>,
          }
          : undefined;

        if (!interp.ok) {
          rows.push({
            name: spec.name,
            feature: spec.feature,
            status: "UNHANDLED",
            reason: interp.reason,
            cov,
          });
          continue;
        }

        // Interpreter ran. Compare to legacy.
        if (legacyError) {
          // Interpreter produced a value but legacy could not run — can't form
          // a differential oracle; record as DIVERGE (no legacy ground truth).
          rows.push({
            name: spec.name,
            feature: spec.feature,
            status: "DIVERGE",
            reason: `interp=${
              brief(interp.value)
            } legacy ERRORED: ${legacyError}`,
            cov,
          });
          continue;
        }

        // For collection rows the interpreter computes the inner mapped/filtered
        // array and legacy now returns the same inner array (read via .key()).
        const interpForCompare = interp.value;
        let legacyForCompare = legacyOut;
        let oracle = "legacy";

        // Collection legacy-harness limitation: the generic harness passes a
        // plain-array arg (not a cell-backed list), so legacy `mapWithPattern`
        // does not materialize and `.key(field).pull()` yields undefined. That
        // is NOT an interpreter divergence — fall back to the independent ground
        // truth so the row reflects the interpreter's actual correctness.
        if (
          coll &&
          (legacyForCompare === undefined || legacyForCompare === null)
        ) {
          legacyForCompare = coll.groundTruth;
          oracle = "ground-truth (legacy harness could not materialize)";
        }

        if (jsonEqual(interpForCompare, legacyForCompare)) {
          rows.push({
            name: spec.name,
            feature: spec.feature,
            status: "MATCH",
            reason: oracle === "legacy"
              ? ""
              : `via ${oracle}; interp=${brief(interpForCompare)}`,
            cov,
          });
        } else {
          rows.push({
            name: spec.name,
            feature: spec.feature,
            status: "DIVERGE",
            reason: `interp=${brief(interpForCompare)} ${oracle}=${
              brief(legacyForCompare)
            }`,
            cov,
          });
        }
      } finally {
        await env.dispose();
      }
    }

    // -----------------------------------------------------------------------
    // Print the coverage table + summary + ranked gap backlog.
    // -----------------------------------------------------------------------
    const matched = rows.filter((r) => r.status === "MATCH").length;
    const diverged = rows.filter((r) => r.status === "DIVERGE").length;
    const unhandled = rows.filter((r) => r.status === "UNHANDLED").length;

    const pad = (s: string, n: number) =>
      s.length >= n ? s : s + " ".repeat(n - s.length);

    console.log("\n=== REACTIVE INTERPRETER CORPUS GAP-MAP ===\n");
    console.log(
      pad("PATTERN", 56) + pad("STATUS", 11) + "REASON / DETAIL",
    );
    console.log("-".repeat(110));
    for (const r of rows) {
      console.log(
        pad(r.name, 56) + pad(r.status, 11) +
          (r.reason || "(value matches legacy)"),
      );
    }
    console.log("-".repeat(110));
    console.log(
      `SUMMARY: matched=${matched}  diverged=${diverged}  unhandled=${unhandled}  (total=${rows.length})\n`,
    );

    // Ranked gap backlog: group UNHANDLED+DIVERGE rows by a normalized reason
    // signature, so the features blocking the most patterns surface first.
    const gapBuckets = new Map<string, { count: number; examples: string[] }>();
    const gapSignature = (r: Row): string => {
      const reason = r.reason;
      if (r.status === "UNHANDLED") {
        const m = reason.match(/NotInterpretedHere[^"]*"([a-z]+)"/);
        if (m) return `NotInterpretedHere: op kind "${m[1]}"`;
        // Handler-wrapper class: a `handler` module is classified as a plain
        // `leaf` (module.type==="javascript"), but it is an event-driven effect
        // with a 2-arg (event, state) convention and `{$event,$ctx}` structured
        // input — not a synchronous single-input value leaf. evalRog calls it as
        // impl(singleInput) → the body dereferences the missing `state`.
        if (r.feature.includes("handler")) {
          return "handler classified as leaf: effect/2-arg (event,state) " +
            "convention + {$event,$ctx} input, not a value leaf";
        }
        // The structured-leaf-input class: a leaf whose builder input is a
        // multi-key / nested-array object (e.g. str's {strings,values}) —
        // extract.ts.inputRefs flattens it to a positional ref list, so the leaf
        // body runs on the wrong-shaped input and throws a TypeError
        // dereferencing the missing key.
        if (
          reason.includes("evalRog threw: TypeError") &&
          reason.includes("Cannot read properties of undefined")
        ) {
          return "extract.inputRefs: structured leaf input not reconstructed " +
            "(multi-key/nested-array object flattened to positional refs)";
        }
        if (reason.includes("no leaf impl")) {
          return "evalRog: missing leaf impl";
        }
        if (reason.includes("unresolved leaf ops")) {
          return "resolveLeafImpls: unresolved leaf (serialized/SES boundary)";
        }
        if (reason.includes("element-evaluator unresolved")) {
          return "element-evaluator: unresolved element leaf";
        }
        if (reason.includes("not an inline Pattern")) {
          return "collection: element op not inline ($patternRef needs SES index)";
        }
        if (reason.includes("no ") && reason.includes(" node found")) {
          return "collection: builtin node not found by implementation name";
        }
        if (reason.includes("extractRog threw")) return "extractRog: threw";
        return `other UNHANDLED: ${reason.slice(0, 60)}`;
      }
      // DIVERGE. Name the known extraction-branch-mapping bug specifically:
      // extract.ts reads only ifTrue/then + ifFalse/else for control branches,
      // but the builder names when's value `value` and unless's fallback
      // `fallback`, so those branches extract to const-undefined → wrong value.
      if (
        r.feature.startsWith("control:") &&
        (r.feature.includes("when") || r.feature.includes("unless"))
      ) {
        return "extract.ts control branches: when `value` / unless `fallback` " +
          "input keys unmapped (only ifTrue/ifFalse/then/else read)";
      }
      return "DIVERGE (interpreter ran, value wrong)";
    };
    for (const r of rows) {
      if (r.status === "MATCH") continue;
      const sig = gapSignature(r);
      const b = gapBuckets.get(sig) ?? { count: 0, examples: [] };
      b.count++;
      b.examples.push(r.feature);
      gapBuckets.set(sig, b);
    }
    const ranked = [...gapBuckets.entries()].sort((a, b) =>
      b[1].count - a[1].count
    );
    console.log(
      "=== RANKED GAP BACKLOG (features blocking the most patterns) ===\n",
    );
    let rank = 1;
    for (const [sig, b] of ranked) {
      console.log(
        `${rank}. [${b.count}x] ${sig}\n      patterns: ${
          [...new Set(b.examples)].join(", ")
        }`,
      );
      rank++;
    }
    console.log();

    // The ONLY assertions: the harness ran and produced a table over the whole
    // corpus, with each row classified into the closed status set. This is a
    // measurement — NOT a parity gate over the set.
    expect(rows.length).toBe(SPECS.length);
    for (const r of rows) {
      expect(["MATCH", "DIVERGE", "UNHANDLED"]).toContain(r.status);
    }
    // At least one row matched (the harness genuinely exercises the interpreter,
    // not just catching every throw) — proves the differential oracle is live.
    expect(matched).toBeGreaterThan(0);
  });
});
