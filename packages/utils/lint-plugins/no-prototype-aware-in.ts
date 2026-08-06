/// <reference lib="deno.unstable" />

// Flags `key in obj` where `key` is not a safe literal.
//
// `in` walks the prototype chain, so it answers YES for every member of
// `Object.prototype` — `toString`, `valueOf`, `hasOwnProperty`,
// `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `constructor`,
// `__proto__` — on every object, whether or not the object carries them. Those
// are ordinary, legal property names in data: unlike `__proto__`/`constructor`
// (refused at the FabricValue boundary), the rest store and round-trip like any
// other key. A pattern with a field named `valueOf` is not exotic.
//
// Asking `in` about a DATA key therefore gets the wrong answer, and the code
// that follows usually indexes — yielding `Object.prototype`'s FUNCTION where
// data was expected. That has cost this codebase real defects: schema defaults
// silently skipped (caller receives a function), required properties satisfied
// by nothing, keys that could not be deleted, a public path helper throwing
// "Cannot compare a function value", and — the one that started this — a proxy
// trap reporting inherited names as own, which took every Loom state-cell push
// offline for three days. See CT-1949 / CT-1951, labs#5357 and labs#5373.
//
// WHAT IS ALLOWED, and why it is safe:
//
//   - A string literal that is not a prototype member name:
//         if ("error" in result)
//     The name is chosen by the code, not derived from data, and cannot
//     collide. This is the ordinary discriminated-union narrowing TypeScript
//     encourages, and it stays idiomatic.
//
//   - A numeric literal:
//         if (0 in arr)
//     An array-index probe. Arrays do not inherit index properties, so `in` is
//     the CORRECT sparse-hole test there.
//
// WHAT IS FLAGGED:
//
//   - A non-literal key — a variable, member expression, or template. The
//     linter cannot see types, so it cannot tell `index in array` (fine) from
//     `key in record` (usually wrong). The former is rare and stable; annotate
//     it once and the annotation documents that the author checked.
//
//   - A string literal that IS a prototype member name, e.g.
//     `"toString" in value`. Even spelled out, this is almost always asking an
//     own-property question with an operator that cannot answer it.
//
// TO FIX: use `Object.hasOwn(obj, key)`.
//
// TO OPT OUT, where `in` is genuinely what you mean — an array sparse-hole
// probe, or a deliberate prototype-chain question — silence it AT THE LINE and
// say which:
//
//     // deno-lint-ignore cf-utils/no-prototype-aware-in -- sparse-hole probe:
//     // arrays do not inherit index properties.
//     if (!(i in value)) continue;
//
// THIS IS NOT WIRED INTO THE WORKSPACE LINT CONFIG, on purpose. Measured on the
// runner + data-model core — the subsystems where this defect has actually
// bitten — it reports ~56 sites, and roughly four in five are CORRECT: array
// sparse-hole probes and the query-result proxy's `has` trap. A rule cannot
// tell those from the real thing without types, and directory-scoping does not
// help, because the core is exactly where the legitimate probes live. Wired
// into CI at that ratio it would teach people to silence it, which is worse
// than not having it.
//
// So it is an AUDIT TOOL. Point it at a subsystem when you are asking the
// question:
//
//     deno lint -c packages/utils/lint-plugins/audit-in-usage.jsonc <paths>
//
// Regression protection for the paths where this bit lives in
// `packages/runner/test/prototype-named-properties.test.ts` — behaviour, not
// syntax, so no false positives and nothing to silence.

interface LintContext {
  readonly filename: string;
  report(report: { node: unknown; message: string }): void;
}

interface LintNode {
  readonly type: string;
  readonly operator?: string;
  readonly left?: {
    readonly type: string;
    readonly value?: unknown;
  };
}

/**
 * Own properties of `Object.prototype`. A key with one of these names is
 * ordinary data, but `in` cannot distinguish "the record carries it" from
 * "every object inherits it".
 */
const PROTOTYPE_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

const FIX =
  "Use `Object.hasOwn(obj, key)`. If `in` is genuinely what you mean (an " +
  "array sparse-hole probe, or a deliberate prototype-chain question), " +
  "silence this at the line with `// deno-lint-ignore " +
  "cf-utils/no-prototype-aware-in -- <why>`.";

export default {
  name: "cf-utils",
  rules: {
    "no-prototype-aware-in": {
      create(context: unknown) {
        const localContext = context as unknown as LintContext;
        return {
          BinaryExpression(node: unknown) {
            const localNode = node as unknown as LintNode;
            if (localNode.operator !== "in") return;
            const left = localNode.left;
            if (left === undefined) return;

            // Deno's AST spells string/number literals a couple of ways
            // depending on version; accept both rather than silently passing
            // everything when the shape changes.
            const isLiteral = left.type === "Literal" ||
              left.type === "StringLiteral" || left.type === "NumericLiteral";

            if (isLiteral && typeof left.value === "number") return;

            if (isLiteral && typeof left.value === "string") {
              if (!PROTOTYPE_MEMBER_NAMES.has(left.value)) return;
              localContext.report({
                node,
                message:
                  `\`"${left.value}" in obj\` is true for every object: ` +
                  `\`${left.value}\` is inherited from Object.prototype. ` +
                  FIX,
              });
              return;
            }

            localContext.report({
              node,
              message:
                "`in` walks the prototype chain, so a key named after an " +
                "Object.prototype member (`toString`, `valueOf`, " +
                "`hasOwnProperty`, …) reads as present on every object. " +
                FIX,
            });
          },
        };
      },
    },
  },
};
