/**
 * The decisions behind `topics-browser-measurement.ts` that need no browser:
 * locating a lift in its authored source, reading a lift's compiled text from
 * an emitted module, deciding whether a lift's module ran, requiring that the
 * board runs the program compiled from the sources read, without coverage
 * instrumentation, and with each lift's preview equal to its compiled text,
 * reading timing deltas and the worker's run count, and ending a sampling after
 * its operation. The module imports nothing, so a plain `deno test` exercises
 * all of it.
 */

/** A position in authored source: line 1-based, column 0-based. */
export interface SourcePosition {
  /** Authored line, 1-based. */
  readonly line: number;

  /** Authored column, 0-based. */
  readonly col: number;
}

/** A lift measured separately, named by its binding. */
export interface TopicsLift {
  /** Binding name of the module-scope `lift()` declaration. */
  readonly name: string;

  /** Declaring module, relative to the program root. */
  readonly module: string;

  /** Whether the lift produces the board's pivot or reads it per topic. */
  readonly role: "producer" | "consumer";
}

/** A named lift located in the sources the board was deployed from. */
export interface TopicsLiftSite extends TopicsLift {
  /** `/<module>:<line>:<col>`, which is how a run's `src` ends. */
  readonly site: string;
}

/** A located lift together with its text as the board's compiler emits it. */
export interface CompiledTopicsLift extends TopicsLiftSite {
  /** The lift's compiled function, whose `toString()` a preview begins. */
  readonly compiledText: string;
}

/** One timing key's samples accumulated over an operation. */
export interface TimingRow {
  /**
   * `<logger>/<key>`, with each all-digit segment written as `*` so that
   * per-batch and per-mount keys add up to one row.
   */
  readonly key: string;

  /** Samples recorded over the operation. */
  readonly count: number;

  /** Their summed duration. */
  readonly totalMs: number;
}

/** One thread's timing statistics as `[count, totalTime]` by `<logger>/<key>`. */
export type TimingSnapshot = Readonly<
  Record<string, readonly [count: number, totalTime: number]>
>;

/**
 * The key under which the worker's `scheduler` logger reports the span
 * `runSchedulerAction` times around each action run, beside that span's
 * `…/run/action` and `…/run/commit` children.
 */
export const WORKER_RUN_TIMING_KEY = "scheduler/scheduler/run";

/**
 * How many characters of an implementation's `toString()` the runner keeps as
 * the preview a graph snapshot reports.
 */
export const PREVIEW_LENGTH = 200;

/** The call pattern coverage instrumentation writes before each statement. */
export const COVERAGE_HIT_CALL = "__cfPatternCoverage?.hit(";

/** Matches a run's `src`: the module identity, then `/<path>:<line>:<col>`. */
const SRC_PATTERN = /^cf:module\/([^/]+)(\/.+:\d+:\d+)$/;

/**
 * Returns where the function argument of `name`'s module-scope
 * `const <name> = lift(<function>)` declaration starts in `text`, which is the
 * position the transformer records for a hoisted builder and the runtime
 * reports in each run's `src`. Comments between the call's parenthesis and the
 * function are skipped; type arguments on `lift`, and a function passed after
 * schema arguments, are not recognized.
 *
 * @throws If `text` holds no such declaration or more than one; `source` names
 *   the text in the message.
 */
export function locateLift(
  text: string,
  name: string,
  source = "the source",
): SourcePosition {
  requirePlainName(name);
  const trivia = String.raw`(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*`;
  const declaration = new RegExp(
    String.raw`\bconst\s+${name}\s*=\s*lift\s*\(` + trivia,
    "g",
  );
  const matches = [...text.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one \`const ${name} = lift(...)\` declaration in ${source}, ` +
        `found ${matches.length}`,
    );
  }
  const [match] = matches;
  const lines = text.slice(0, match.index + match[0].length).split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length };
}

/**
 * Returns the function the compiled module `js` passes to the lift declared as
 * `const <name> = (0, <alias>.lift)(<function>, ...)`, the form the compiler
 * emits for an authored `const <name> = lift(<function>)`. The text is what the
 * function's `toString()` returns, so a running action's preview is its first
 * {@link PREVIEW_LENGTH} characters. The argument's end is found by scanning
 * tokens, so brackets inside strings, template literals, regular expressions,
 * and comments do not end it.
 *
 * @throws If `js` holds no such declaration or more than one, or the call has
 *   no argument that closes; `source` names the module in the message.
 */
export function compiledLiftText(
  js: string,
  name: string,
  source = "the compiled module",
): string {
  requirePlainName(name);
  const declaration = new RegExp(
    String.raw`\bconst\s+${name}\s*=\s*\(0,\s*[A-Za-z_$][\w$]*\.lift\)\(`,
    "g",
  );
  const matches = [...js.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one compiled \`const ${name} = (0, <alias>.lift)(...)\` ` +
        `declaration in ${source}, found ${matches.length}`,
    );
  }
  const [match] = matches;
  let depth = 0;
  let first: Token | undefined;
  let last: Token | undefined;
  for (const token of scanTokens(js, match.index + match[0].length)) {
    if (depth === 0 && (token.text === "," || token.text === ")")) {
      if (first === undefined || last === undefined) break;
      return js.slice(first.start, last.end);
    }
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      depth++;
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      depth--;
    }
    first ??= token;
    last = token;
  }
  throw new Error(
    `The compiled \`${name}\` lift call in ${source} has no argument that ` +
      `closes`,
  );
}

/** Splits a run's `src` into module identity and site, if it has that form. */
export function parseSrc(
  src: string,
): { identity: string; site: string } | undefined {
  const match = SRC_PATTERN.exec(src);
  return match ? { identity: match[1], site: match[2] } : undefined;
}

/**
 * Returns, by site, whether each lift's module ran according to `srcs`, the
 * `src` values of actions seen around an operation.
 *
 * A lift's module has not started when no `src` names `/<module>`. The lift is
 * then reported `false` only if no `src` names its module's file under any
 * other path either, so a lift that ran where its site was not resolved fails
 * rather than reading as zero runs. A `src` naming `/<module>` under another
 * root fails whether or not `/<module>` runs, since that copy's runs would be
 * counted as another lift's.
 *
 * @throws If a `src` names the module's file as described above, including in
 *   a form {@link parseSrc} does not accept; if the module runs as more than
 *   one version; or if it runs and holds no action at the lift's site.
 */
export function liftRunningStates(
  lifts: readonly TopicsLiftSite[],
  srcs: Iterable<string>,
): Map<string, boolean> {
  const sites = new Set<string>();
  const identitiesByModule = new Map<string, Set<string>>();
  const unparsed: string[] = [];
  for (const src of srcs) {
    const parsed = parseSrc(src);
    if (parsed === undefined) {
      if (src !== "") unparsed.push(src);
      continue;
    }
    sites.add(parsed.site);
    const module = moduleOf(parsed.site);
    const identities = identitiesByModule.get(module) ?? new Set();
    identities.add(parsed.identity);
    identitiesByModule.set(module, identities);
  }
  const modules = [...identitiesByModule.keys()];
  const states = new Map<string, boolean>();
  for (const lift of lifts) {
    const expected = `/${lift.module}`;
    const file = `/${lift.module.split("/").at(-1)}`;
    const copies = [
      ...modules.filter((module) =>
        module !== expected && module.endsWith(expected)
      ),
      ...unparsed.filter((src) => src.includes(expected)),
    ];
    if (copies.length > 0) {
      throw new Error(
        `\`${lift.name}\` was resolved in \`${expected}\`, but that module ` +
          `also runs as ${copies.map((path) => `\`${path}\``).join(", ")}`,
      );
    }
    const identities = identitiesByModule.get(expected);
    if (identities === undefined) {
      const namings = [
        ...modules.filter((module) => module.endsWith(file)),
        ...unparsed.filter((src) => src.includes(file)),
      ];
      if (namings.length > 0) {
        throw new Error(
          `\`${lift.name}\` was resolved in \`${expected}\`, which has not ` +
            `started, but its file runs as ${
              namings.map((path) => `\`${path}\``).join(", ")
            }`,
        );
      }
      states.set(lift.site, false);
      continue;
    }
    if (identities.size > 1) {
      throw new Error(
        `\`${expected}\` runs as ${identities.size} module versions, so ` +
          `\`${lift.name}\` cannot be attributed by position`,
      );
    }
    if (!sites.has(lift.site)) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but the running ` +
          `\`${expected}\` has no action there: the sources read are not the ` +
          `ones the board runs`,
      );
    }
    states.set(lift.site, true);
  }
  return states;
}

/**
 * Fails a sample taken on a board running a Topics module other than the one
 * compiled from the sources read. `identities` holds the content identity of
 * each compiled Topics module by `/<module>`; `srcs` are the `src` values of
 * actions seen around the operation, each of which begins
 * `cf:module/<identity>`. A module no `src` names is not checked, since nothing
 * ran from it.
 *
 * @throws If `identities` lacks a lift's module, or a `src` naming a module in
 *   `identities` carries another identity.
 */
export function requireSameProgram(
  lifts: readonly TopicsLift[],
  identities: ReadonlyMap<string, string>,
  srcs: Iterable<string>,
): void {
  const running = new Map<string, Set<string>>();
  for (const src of srcs) {
    const parsed = parseSrc(src);
    if (parsed === undefined) continue;
    const module = moduleOf(parsed.site);
    const seen = running.get(module) ?? new Set();
    seen.add(parsed.identity);
    running.set(module, seen);
  }
  for (const lift of lifts) {
    if (!identities.has(`/${lift.module}`)) {
      throw new Error(
        `The program compiled from the sources read has no module ` +
          `\`/${lift.module}\``,
      );
    }
  }
  for (const [module, compiled] of identities) {
    for (const identity of running.get(module) ?? []) {
      if (identity !== compiled) {
        throw new Error(
          `\`${module}\` runs as module \`${identity}\`, but the sources read ` +
            `compile it to \`${compiled}\`: the sources read are not the ` +
            `program the board runs`,
        );
      }
    }
  }
}

/**
 * Fails a sample taken where pattern coverage instruments the running code.
 * Instrumentation writes a hit call before each statement of every lift, so
 * no preview could equal the uninstrumented compiled text. `collecting` is
 * whether the page's worker holds a coverage collector; `previews` are the
 * implementation previews the graph reports.
 *
 * @throws If `collecting` is true, or a preview holds
 *   {@link COVERAGE_HIT_CALL}.
 */
export function requireNoCoverage(
  collecting: boolean,
  previews: Iterable<string>,
): void {
  if (collecting) {
    throw new Error(
      "The page's worker collects pattern coverage, whose instrumentation " +
        "rewrites every lift's code: measure on a page without coverage",
    );
  }
  for (const preview of previews) {
    if (preview.includes(COVERAGE_HIT_CALL)) {
      throw new Error(
        "A running implementation holds pattern coverage instrumentation, " +
          `which rewrites every lift's code: \`${preview.split("\n")[0]}\``,
      );
    }
  }
}

/**
 * Returns, by site, the preview of the implementation running at each running
 * lift's site, after requiring that every preview found there equals the first
 * {@link PREVIEW_LENGTH} characters of the lift's compiled text. `actions` are
 * graph snapshots' previews by `src`; `running` is {@link liftRunningStates}'s
 * result.
 *
 * @throws If a running lift's site holds no action with a preview in any of
 *   `actions`, which happens when the lift's only actions ran and were removed
 *   between snapshots, or if a preview there differs from the compiled text;
 *   that message names the lift and quotes both texts from their first
 *   difference.
 */
export function confirmLiftImplementations(
  lifts: readonly CompiledTopicsLift[],
  actions: readonly Readonly<Record<string, readonly string[]>>[],
  running: ReadonlyMap<string, boolean>,
): Map<string, string> {
  const previews = new Map<string, Set<string>>();
  for (const snapshot of actions) {
    for (const [src, found] of Object.entries(snapshot)) {
      const site = parseSrc(src)?.site;
      if (site === undefined) continue;
      const atSite = previews.get(site) ?? new Set();
      for (const preview of found) atSite.add(preview);
      previews.set(site, atSite);
    }
  }
  const confirmed = new Map<string, string>();
  for (const lift of lifts) {
    if (running.get(lift.site) !== true) continue;
    const atSite = [...(previews.get(lift.site) ?? [])];
    if (atSite.length === 0) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but no action in a ` +
          `graph snapshot there shows its implementation to confirm it by`,
      );
    }
    const expected = lift.compiledText.slice(0, PREVIEW_LENGTH);
    const other = atSite.find((preview) => preview !== expected);
    if (other !== undefined) {
      const at = firstDifference(other, expected);
      throw new Error(
        `\`${lift.name}\` at \`${lift.site}\` runs an implementation that ` +
          `differs from its compiled text at character ${at}: running ` +
          `${JSON.stringify(other.slice(at, at + 40))}, compiled ` +
          `${JSON.stringify(expected.slice(at, at + 40))}`,
      );
    }
    confirmed.set(lift.site, expected);
  }
  return confirmed;
}

/**
 * Fails a sample whose runs cannot be attributed to lifts by position. `srcs`
 * are the `src` keys of the runs that carried a read sample, a run with no
 * `src` keyed by the empty string; `running` is {@link liftRunningStates}'s
 * result. Every sample is taken on a page showing the board, so a producer
 * lift's module that is not running means the positions read say nothing
 * about the runs, not that the producer ran nothing.
 *
 * @throws If `srcs` is not empty and none of them is in the form
 *   {@link parseSrc} accepts, or if a producer lift is not running.
 */
export function requireAttributableRuns(
  lifts: readonly TopicsLiftSite[],
  running: ReadonlyMap<string, boolean>,
  srcs: readonly string[],
): void {
  if (srcs.length > 0 && srcs.every((src) => parseSrc(src) === undefined)) {
    throw new Error(
      `Runs with a read sample carried no source location to attribute them ` +
        `by: ${srcs.map((src) => `\`${src}\``).join(", ")}`,
    );
  }
  for (const lift of lifts) {
    if (lift.role === "producer" && running.get(lift.site) !== true) {
      throw new Error(
        `\`${lift.name}\`'s module \`/${lift.module}\` is not running, but a ` +
          `sample is taken on a page showing the board`,
      );
    }
  }
}

/**
 * Returns the timing recorded between two snapshots of one thread, joining
 * keys that differ only in an all-digit segment and dropping keys whose last
 * segment is in `exclude`, slowest total first.
 */
export function timingDelta(
  before: TimingSnapshot,
  after: TimingSnapshot,
  exclude: ReadonlySet<string> = new Set(),
): TimingRow[] {
  const rows = new Map<string, { count: number; totalMs: number }>();
  for (const [key, [count, totalTime]] of Object.entries(after)) {
    const [countBefore, totalBefore] = before[key] ?? [0, 0];
    const segments = key.split("/");
    if (count <= countBefore || exclude.has(segments.at(-1)!)) continue;
    const joined = segments.map((segment) =>
      /^\d+$/.test(segment) ? "*" : segment
    ).join("/");
    const row = rows.get(joined) ?? { count: 0, totalMs: 0 };
    row.count += count - countBefore;
    row.totalMs += totalTime - totalBefore;
    rows.set(joined, row);
  }
  return [...rows.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Returns how many action runs the worker's scheduler timed between two
 * snapshots of its timing, under {@link WORKER_RUN_TIMING_KEY}. Runs that
 * overlap share that span's one timer, and only the first to end is recorded,
 * so the count is a lower bound; a run completing at all records at least one.
 *
 * @throws If `after` has no such key, which would make every count zero.
 */
export function workerRunCount(
  before: TimingSnapshot,
  after: TimingSnapshot,
): number {
  const counted = after[WORKER_RUN_TIMING_KEY];
  if (counted === undefined) {
    throw new Error(
      `The worker's timing has no \`${WORKER_RUN_TIMING_KEY}\` key to count ` +
        `runs by`,
    );
  }
  return counted[0] - (before[WORKER_RUN_TIMING_KEY]?.[0] ?? 0);
}

/**
 * Runs `run`, then `stop` whether or not `run` succeeded, and returns both
 * results.
 *
 * @throws `run`'s error when only `run` fails, `stop`'s error when only `stop`
 *   fails, and an `AggregateError` holding `run`'s error and then `stop`'s
 *   when both fail.
 */
export async function runThenStop<T, S>(
  run: () => Promise<T>,
  stop: () => Promise<S>,
): Promise<{ value: T; stopped: S }> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let stopped: S;
  try {
    stopped = await stop();
  } catch (stopError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, stopError],
        "The operation failed, and stopping its sampling failed after it",
      );
    }
    throw stopError;
  }
  if (!outcome.ok) throw outcome.error;
  return { value: outcome.value, stopped };
}

/** Helper for the lookups above, which refuses a name that is not plain. */
function requirePlainName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`\`${name}\` is not a plain identifier`);
  }
}

/** Helper for the decisions above, which returns a site's module path. */
function moduleOf(site: string): string {
  return site.replace(/:\d+:\d+$/, "");
}

/**
 * Helper for {@link confirmLiftImplementations}, which returns the index of
 * the first character where `a` and `b` differ, or the shorter one's length.
 */
function firstDifference(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return at;
}

//
// Token scanning
//

/** One token of source, with where it starts and ends. */
interface Token {
  /** The token's text. */
  text: string;

  /** Offset of its first character. */
  start: number;

  /** Offset just past its last character. */
  end: number;
}

/** Multi-character punctuators, longest first. */
const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

/**
 * Keywords after which a `/` starts a regular expression literal rather than a
 * division.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Helper for {@link compiledLiftText}, which yields the tokens of `text` from
 * offset `from`: identifiers, numbers, string, template, and regular
 * expression literals, and punctuators, with whitespace and comments dropped.
 * A template literal is one token, `${...}` substitutions included. An
 * unterminated literal ends at the end of `text`, or for a quoted string at an
 * unescaped line break.
 */
function* scanTokens(text: string, from = 0): Generator<Token> {
  const word = /[A-Za-z_$][\w$]*|\d[\w.]*|\.\d\w*/y;
  let previous: string | undefined;
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    if (text.startsWith("//", at)) {
      const newline = text.indexOf("\n", at);
      at = newline === -1 ? text.length : newline;
      continue;
    }
    if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      at = close === -1 ? text.length : close + 2;
      continue;
    }
    let end: number;
    if (char === '"' || char === "'") {
      end = quotedEnd(text, at);
    } else if (char === "`") {
      end = templateEnd(text, at);
    } else if (char === "/" && startsRegex(previous)) {
      end = regexEnd(text, at);
    } else {
      word.lastIndex = at;
      const matched = word.exec(text)?.[0] ??
        PUNCTUATORS.find((punctuator) =>
          text.startsWith(punctuator, at) &&
          !(punctuator === "?." && /\d/.test(text[at + 2] ?? ""))
        ) ?? char;
      end = at + matched.length;
    }
    const token = { text: text.slice(at, end), start: at, end };
    previous = token.text;
    yield token;
    at = end;
  }
}

/**
 * Helper for {@link scanTokens}, which returns the offset past the quoted
 * string starting at `at`.
 */
function quotedEnd(text: string, at: number): number {
  const quote = text[at];
  for (let end = at + 1; end < text.length; end++) {
    if (text[end] === "\\") end++;
    else if (text[end] === quote) return end + 1;
    else if (text[end] === "\n") return end;
  }
  return text.length;
}

/**
 * Helper for {@link scanTokens}, which returns the offset past the template
 * literal starting at `at`, reading each `${...}` substitution as code.
 */
function templateEnd(text: string, at: number): number {
  let end = at + 1;
  while (end < text.length) {
    if (text[end] === "\\") {
      end += 2;
    } else if (text[end] === "`") {
      return end + 1;
    } else if (text.startsWith("${", end)) {
      end = substitutionEnd(text, end + 2);
    } else {
      end++;
    }
  }
  return text.length;
}

/**
 * Helper for {@link templateEnd}, which returns the offset past the `}` closing
 * a substitution whose code starts at `from`.
 */
function substitutionEnd(text: string, from: number): number {
  let depth = 0;
  for (const token of scanTokens(text, from)) {
    if (token.text === "{") {
      depth++;
    } else if (token.text === "}") {
      if (depth === 0) return token.end;
      depth--;
    }
  }
  return text.length;
}

/**
 * Helper for {@link scanTokens}, which returns whether a `/` after `previous`
 * starts a regular expression literal: at the start, after a keyword that
 * takes an expression, or after a punctuator other than a closing bracket.
 */
function startsRegex(previous: string | undefined): boolean {
  if (previous === undefined) return true;
  if (REGEX_PRECEDING_KEYWORDS.has(previous)) return true;
  return !/^[\w$"'`]/.test(previous) && previous !== ")" &&
    previous !== "]" && previous !== "}";
}

/**
 * Helper for {@link scanTokens}, which returns the offset past the regular
 * expression literal starting at `at`, or past the `/` alone when no literal
 * closes on its line.
 */
function regexEnd(text: string, at: number): number {
  let inClass = false;
  for (let end = at + 1; end < text.length; end++) {
    const char = text[end];
    if (char === "\\") {
      end++;
    } else if (char === "\n") {
      return at + 1;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      const flags = /[A-Za-z]*/y;
      flags.lastIndex = end + 1;
      return end + 1 + (flags.exec(text)?.[0].length ?? 0);
    }
  }
  return at + 1;
}
