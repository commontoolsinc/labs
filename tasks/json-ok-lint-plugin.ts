/// <reference lib="deno.unstable" />

//
// A `deno lint` plugin that requires every `JSON.parse()` and
// `JSON.stringify()` call to carry a `json-ok:` comment saying why a plain-JSON
// round trip is correct at that spot.
//
// The two functions are lossy against the values this runtime moves around.
// `JSON.stringify()` renders `NaN` and `±Infinity` as `null`, drops `undefined`
// members, emits keys in insertion order rather than a canonical one, and
// rebuilds a `FabricInstance` as a plain record — stripping the class identity
// that a `FabricError`, `FabricBytes`, or `FabricLink` carries. `JSON.parse()`
// inverts none of that. Each loss has already produced a live defect: the
// `{value: NaN}` event that transported as `{"value":null}` and was then
// rejected by schema validation, and the `createDataCellURI` walk that
// decomposes a `FabricPrimitive`.
//
// Plenty of call sites are fine — a config file read off disk, a log line, a
// test fixture, an HTTP body whose contract *is* JSON. The rule does not try to
// tell those apart from the dangerous ones, because it cannot. It asks the
// author to say which one this is, so that the answer is written down once and
// reviewable, rather than re-derived by whoever next reads the line.
//
// ## The marker
//
// A call is justified when a comment line whose first text is `json-ok:`,
// followed by a non-empty reason, sits either:
//
//   - on the same line as the call,
//   - in the run of whole-line comments directly above the call, or
//   - in the run directly above the statement holding it,
//
// in each case with no blank line in between. The statement anchor reads best
// when the call is the point of the line; the call anchor is the only one
// available when the call sits deep inside a multi-line expression.
//
// Both `//` and `/* */` comments carry it, and a leading `*` (a JSDoc
// continuation) is ignored, so the marker reads naturally inside a doc comment.
//
// ## The baseline
//
// The repository predates the rule by some thousand call sites, so
// `json-ok-baseline.json` records, per file, how many unjustified calls that
// file is currently allowed. A file at or under its budget reports nothing; a
// file over budget reports every unjustified call it holds, because a count
// cannot say which one is new. A file absent from the baseline has a budget of
// zero, so new files are held to the rule in full.
//
// The budget only ever ratchets down: `tasks/check-json-ok.ts` fails when a
// file exceeds its budget *and* when a file comes in under it, the latter
// asking for the baseline to be regenerated so the reclaimed ground cannot be
// given back. Setting `CF_JSON_OK_REPORT_ALL` makes the plugin ignore the
// baseline entirely and report every unjustified call; that is how the checker
// counts what is actually there.

import { dirname, fromFileUrl, isAbsolute, relative, resolve } from "@std/path";

/** Repository root, derived from this file's own location. */
export const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Absolute path of the checked-in baseline. */
export const BASELINE_PATH = resolve(REPO_ROOT, "tasks/json-ok-baseline.json");

/** The plugin name, which prefixes the diagnostic code. */
export const PLUGIN_NAME = "cf-lint";

/** The rule name, which follows the plugin name in the diagnostic code. */
export const RULE_NAME = "require-json-ok";

/** The full diagnostic code, as `deno lint --json` reports it. */
export const DIAGNOSTIC_CODE = `${PLUGIN_NAME}/${RULE_NAME}`;

/** The comment marker that justifies a call. */
export const MARKER = "json-ok:";

/**
 * Environment variable that makes the plugin ignore the baseline and report
 * every unjustified call.
 */
export const REPORT_ALL_ENV = "CF_JSON_OK_REPORT_ALL";

/**
 * How many unjustified calls each file may hold, keyed by repo-relative path.
 * A file absent from the map has a budget of zero.
 */
export type JsonOkBaseline = Readonly<Record<string, number>>;

/** The `JSON` members this rule governs. */
const GOVERNED_METHODS: ReadonlySet<string> = new Set(["parse", "stringify"]);

/**
 * Returns the reason carried by a single line of comment text, or `null` when
 * that line does not open with the marker. A leading `*` is dropped first, so
 * the marker reads the same inside a JSDoc block as on its own line.
 */
export function markerReason(commentLine: string): string | null {
  const text = commentLine.trim().replace(/^\*+\s*/, "");
  if (!text.startsWith(MARKER)) return null;
  return text.slice(MARKER.length).trim();
}

/**
 * Returns whether a reason is substantive enough to stand as a justification.
 * The bar is deliberately low — one letter — because a linter cannot judge
 * whether prose is *true*, and a length threshold only teaches authors to pad.
 * It exists to reject the bare `// json-ok:` that says nothing at all; whether
 * the reason is a good one is a review question.
 */
export function isSubstantiveReason(reason: string): boolean {
  return /\p{L}/u.test(reason);
}

/** Returns whether any line of a comment's text carries a valid marker. */
export function commentCarriesMarker(commentValue: string): boolean {
  for (const line of commentValue.split("\n")) {
    const reason = markerReason(line);
    if (reason !== null && isSubstantiveReason(reason)) return true;
  }
  return false;
}

/** Byte offsets at which each line of `text` starts. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

/** The zero-based line holding `offset`, by binary search over line starts. */
function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Converts a lint context's filename to a repo-relative, `/`-separated path. */
export function repoRelative(filename: string, root: string = REPO_ROOT) {
  const abs = isAbsolute(filename) ? filename : resolve(root, filename);
  return relative(root, abs).replaceAll("\\", "/");
}

/**
 * Reads the checked-in baseline. A missing file reads as an empty baseline,
 * which is the honest answer before the first one is generated.
 */
export function loadBaseline(path: string = BASELINE_PATH): JsonOkBaseline {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
  // json-ok: the baseline is a file this repository writes itself, in
  // `formatBaseline()` below, out of `/`-joined path strings and integers.
  return JSON.parse(text) as JsonOkBaseline;
}

/**
 * Renders a baseline as the file's canonical text: keys sorted, one per line,
 * trailing newline. Sorting keeps an unrelated pair of edits from colliding on
 * the same line, and keeps a regeneration diff to just the files that moved.
 */
export function formatBaseline(baseline: JsonOkBaseline): string {
  const entries = Object.entries(baseline)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // json-ok: writing this repository's own baseline file, whose values are
  // path strings and integers.
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/**
 * Whether the environment asks for every unjustified call, baseline ignored.
 * Read once, at load, because `deno lint` holds the plugin across files.
 */
function reportAllRequested(): boolean {
  try {
    return (Deno.env.get(REPORT_ALL_ENV) ?? "") !== "";
  } catch {
    // `deno lint` grants the plugin the process's permissions; a run without
    // `--allow-env` still gets the baseline-respecting behavior.
    return false;
  }
}

/** One governed call that carries no justification. */
interface UnjustifiedCall {
  /** Byte range of the `JSON.<method>` member expression. */
  range: [number, number];
  /** The member that was called. */
  method: string;
}

/**
 * Builds the plugin against a given baseline. `deno lint` gets the checked-in
 * one; the checker and the tests supply their own.
 */
export function makeJsonOkPlugin(
  baseline: JsonOkBaseline,
  options: { readonly reportAll?: boolean } = {},
): Deno.lint.Plugin {
  const reportAll = options.reportAll ?? reportAllRequested();

  return {
    name: PLUGIN_NAME,
    rules: {
      "require-json-ok": {
        create(ctx) {
          const text = ctx.sourceCode.text;
          const lineStarts = lineStartsOf(text);
          const relPath = repoRelative(ctx.filename);
          const budget = reportAll ? 0 : (baseline[relPath] ?? 0);

          // A marker comment sitting alone on its line, indexed by the line it
          // ends on, so a run of them can be walked upwards from a statement.
          const markerBlockEndingAt = new Map<number, number>();
          // Lines carrying a marker comment that shares the line with code.
          const markerTrailingLines = new Set<number>();
          // Every whole-line comment, marker or not, indexed by end line, so a
          // marker several comment lines above a statement still counts.
          const blockEndingAt = new Map<number, number>();

          for (const comment of ctx.sourceCode.getAllComments()) {
            const [start, end] = comment.range;
            const startLine = lineOf(lineStarts, start);
            const endLine = lineOf(lineStarts, end - 1);
            const ownsItsLine =
              text.slice(lineStarts[startLine], start).trim() === "";
            const carries = commentCarriesMarker(comment.value);

            if (!ownsItsLine) {
              if (carries) markerTrailingLines.add(startLine);
              continue;
            }
            blockEndingAt.set(endLine, startLine);
            if (carries) markerBlockEndingAt.set(endLine, startLine);
          }

          /**
           * Whether a marker sits in the unbroken run of whole-line comments
           * ending just above `line`. A blank line or a line of code ends the
           * run, so a marker cannot reach forward past the statement it was
           * written for.
           */
          const markerAbove = (line: number): boolean => {
            let cursor = line - 1;
            while (blockEndingAt.has(cursor)) {
              if (markerBlockEndingAt.has(cursor)) return true;
              cursor = blockEndingAt.get(cursor)! - 1;
            }
            return false;
          };

          const unjustified: UnjustifiedCall[] = [];

          return {
            MemberExpression(node) {
              if (
                node.object.type !== "Identifier" ||
                node.object.name !== "JSON"
              ) {
                return;
              }

              // `JSON.parse` and `JSON["parse"]` reach the same function.
              const property = node.property;
              const method = property.type === "Identifier" && !node.computed
                ? property.name
                : (property.type === "Literal" &&
                    typeof property.value === "string")
                ? property.value
                : undefined;
              if ((method === undefined) || !GOVERNED_METHODS.has(method)) {
                return;
              }

              const callLine = lineOf(lineStarts, node.range[0]);
              if (markerTrailingLines.has(callLine)) return;

              // Directly above the call is where an author writing about this
              // one call puts the reason, and it is the only spot available
              // when the call sits deep inside a multi-line expression.
              if (markerAbove(callLine)) return;

              // Above the whole statement is where an author writing about the
              // line as a whole puts it, which reads better when the call is
              // the point of the statement rather than a detail within it.
              const ancestors = ctx.sourceCode.getAncestors(node);
              for (let i = ancestors.length - 1; i >= 0; i--) {
                if (/(?:Statement|Declaration)$/.test(ancestors[i].type)) {
                  if (markerAbove(lineOf(lineStarts, ancestors[i].range[0]))) {
                    return;
                  }
                  break;
                }
              }

              unjustified.push({ range: node.range, method });
            },

            "Program:exit"() {
              if (unjustified.length <= budget) return;
              unjustified.sort((a, b) => a.range[0] - b.range[0]);
              for (const call of unjustified) {
                ctx.report({
                  range: call.range,
                  message: messageFor(call.method, unjustified.length, budget),
                  hint: HINT,
                });
              }
            },
          };
        },
      },
    },
  };
}

const HINT =
  `Write the reason on the line above, or at the end of this line, as ` +
  `\`// ${MARKER} <why a plain-JSON round trip is correct here>\`.`;

/** The diagnostic text for one call, given the file's standing. */
function messageFor(method: string, found: number, budget: number): string {
  const base = `\`JSON.${method}()\` without a \`${MARKER}\` justification.`;
  if (budget === 0) return base;
  return `${base} This file's baseline budget is ${budget} unjustified ` +
    `call(s) and it now holds ${found}; every one is listed so the new one ` +
    `can be justified, or an existing one retired to stay within budget.`;
}

export default makeJsonOkPlugin(loadBaseline());
