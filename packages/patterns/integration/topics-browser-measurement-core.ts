/**
 * The decisions behind `topics-browser-measurement.ts` that need no browser:
 * locating a lift in its source, deciding whether its module ran, confirming
 * which implementation runs at its position, reading timing deltas and the
 * worker's run count, and ending a sampling after its operation. The module
 * imports nothing, so a plain `deno test` exercises all of it.
 */

/** A position in authored source: line 1-based, column 0-based. */
export interface SourcePosition {
  /** Authored line, 1-based. */
  readonly line: number;

  /** Authored column, 0-based. */
  readonly col: number;
}

/** Where a lift sits in its module's text. */
export interface LiftDeclaration {
  /** Where the lift's function starts, which a run's `src` reports. */
  readonly position: SourcePosition;

  /**
   * The declaration's text from the function's start up to the next line that
   * starts at column 0 with anything but a closing bracket.
   */
  readonly text: string;
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

/** A located lift together with the declaration it was located by. */
export interface ResolvedTopicsLift extends TopicsLiftSite {
  /** {@link LiftDeclaration.text} for the lift. */
  readonly declaration: string;
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
 * How many characters of an implementation's source the runner keeps as its
 * preview. A preview this long may end partway through a token.
 */
export const PREVIEW_LENGTH = 200;

/**
 * How many tokens a preview cut at {@link PREVIEW_LENGTH} must reach past its
 * function's first `=>` to confirm a lift by. A cut preview is compared only up
 * to the cut, so one that barely reaches the body says little about the code
 * running there; eight tokens is an opening expression or statement.
 */
export const MIN_CUT_PREVIEW_BODY_TOKENS = 8;

/** Matches a run's `src`: the module identity, then `/<path>:<line>:<col>`. */
const SRC_PATTERN = /^cf:module\/([^/]+)(\/.+:\d+:\d+)$/;

/**
 * Matches a line that starts at column 0 with anything but a closing bracket,
 * which in module-scope code starts a statement or a comment of its own.
 */
const TOP_LEVEL_START = /(?<=\n)[^\s)\]}]/;

/**
 * Returns where the function argument of `name`'s module-scope
 * `const <name> = lift(<function>)` declaration starts in `text`, which is the
 * position the transformer records for a hoisted builder and the runtime
 * reports in each run's `src`, and the declaration's text from there. Comments
 * between the call's parenthesis and the function are skipped; type arguments
 * on `lift`, and a function passed after schema arguments, are not recognized.
 * The declaration's text ends at the next line starting at column 0 with
 * anything but a closing bracket, so a lift body holding such a line, as a
 * multi-line template literal can, is cut short and fails to match.
 *
 * @throws If `text` holds no such declaration or more than one; `source` names
 *   the text in the message.
 */
export function locateLift(
  text: string,
  name: string,
  source = "the source",
): LiftDeclaration {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`\`${name}\` is not a plain identifier`);
  }
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
  const start = match.index + match[0].length;
  const lines = text.slice(0, start).split("\n");
  const rest = text.slice(start);
  const end = TOP_LEVEL_START.exec(rest);
  return {
    position: { line: lines.length, col: lines[lines.length - 1].length },
    text: end === null ? rest : rest.slice(0, end.index),
  };
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
    const module = parsed.site.replace(/:\d+:\d+$/, "");
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
 * Returns whether `preview`, the runner's copy of an implementation's emitted
 * source, is the function `declaration` authors, compared token by token with
 * comments and whitespace dropped. Four differences are allowed:
 *
 * - type syntax in the declaration: annotations on parameters, destructured
 *   parameters, variables, and arrow return types; `as` and `satisfies`
 *   assertions; a postfix `!`; an optional parameter's `?`; and type arguments
 *   or type parameters before a `(`;
 * - the module alias the compiler puts on an imported name, `(0, alias_2.name)`
 *   or `alias_2.name`;
 * - a trailing comma before a closing bracket;
 * - the preview's cut at {@link PREVIEW_LENGTH} characters.
 *
 * A complete preview must end where the declaration's function does, followed
 * only by the lift call's `)` and `;`. A cut preview drops its last token,
 * which the cut may have split, and must reach
 * {@link MIN_CUT_PREVIEW_BODY_TOKENS} tokens past its first `=>`. Type syntax
 * is recognized by the positions it takes, not by parsing, so a declaration
 * using it anywhere else fails to match rather than matching another function.
 */
export function implementationMatches(
  preview: string,
  declaration: string,
): boolean {
  const cut = preview.length >= PREVIEW_LENGTH;
  const emitted = withoutTrailingCommas(
    withoutModuleAliases(tokenize(preview)),
  );
  if (cut) emitted.pop();
  if (emitted.length === 0) return false;
  if (cut) {
    const arrow = emitted.indexOf("=>");
    if (
      arrow === -1 ||
      emitted.length - arrow - 1 < MIN_CUT_PREVIEW_BODY_TOKENS
    ) {
      return false;
    }
  }
  const authored = withoutTrailingCommas(tokenize(declaration));
  const walk: DeclarationWalk = { open: [], opens: new Map() };
  let at = 0;
  for (const token of emitted) {
    while (authored[at] !== token) {
      const next = afterTypeSyntax(authored, at, token, walk);
      if (next === undefined) return false;
      at = next;
    }
    if (token === "(" || token === "[" || token === "{") {
      walk.open.push(at);
    } else if (token === ")" || token === "]" || token === "}") {
      const opener = walk.open.pop();
      if (opener !== undefined) walk.opens.set(at, opener);
    }
    at++;
  }
  if (cut) return true;
  while (authored[at] === "as" || authored[at] === "satisfies") {
    const next = afterTypeSyntax(authored, at, undefined, walk);
    if (next === undefined) return false;
    at = next;
  }
  const rest = authored.slice(at);
  return rest[0] === ")" &&
    (rest.length === 1 || (rest.length === 2 && rest[1] === ";"));
}

/**
 * Returns, by site, the preview of the implementation running at each running
 * lift's site, after confirming each preview found there with
 * {@link implementationMatches}. `actions` are graph snapshots' previews by
 * `src`; `running` is {@link liftRunningStates}'s result.
 *
 * @throws If a running lift's site holds no action with a preview in any of
 *   `actions`, which happens when the lift's only actions ran and were removed
 *   between snapshots, or if an action there runs another function.
 */
export function confirmLiftImplementations(
  lifts: readonly ResolvedTopicsLift[],
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
    const other = atSite.find((preview) =>
      !implementationMatches(preview, lift.declaration)
    );
    if (other !== undefined) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but the action there ` +
          `runs \`${other.split("\n")[0]}\`: the sources read are not the ` +
          `ones the board runs`,
      );
    }
    confirmed.set(lift.site, atSite[0]);
  }
  return confirmed;
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

//
// Token comparison
//

/** Where a declaration's walk stands: its open brackets and matched pairs. */
interface DeclarationWalk {
  /** Indices of the brackets opened and not yet closed. */
  open: number[];

  /** The index of each closed bracket's opener, by the closer's index. */
  opens: Map<number, number>;
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

/** Tokens that may end a parameter's type annotation. */
const PARAMETER_TYPE_ENDS: ReadonlySet<string> = new Set([",", ")", "="]);

/** Tokens that may end a variable's type annotation. */
const VARIABLE_TYPE_ENDS: ReadonlySet<string> = new Set(["=", ";", ","]);

/** Tokens that may end an arrow function's return type. */
const RETURN_TYPE_ENDS: ReadonlySet<string> = new Set(["=>"]);

/** Tokens that may end the type of an `as` or `satisfies` assertion. */
const ASSERTION_ENDS: ReadonlySet<string> = new Set([
  ")",
  ",",
  ";",
  "]",
  "}",
]);

/** Keywords that declare a variable. */
const VARIABLE_KEYWORDS: ReadonlySet<string> = new Set(["const", "let", "var"]);

/**
 * Helper for {@link implementationMatches}, which splits source into
 * identifiers, numbers, string and template literals, and punctuators, dropping
 * whitespace and comments. An unterminated literal runs to the end.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const word = /[A-Za-z_$][\w$]*|\d[\w.]*|\.\d\w*/y;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) {
      at++;
    } else if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);
      at = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end === -1 ? text.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < text.length && text[end] !== char) {
        end += text[end] === "\\" ? 2 : 1;
      }
      tokens.push(text.slice(at, end + 1));
      at = end + 1;
    } else {
      word.lastIndex = at;
      const matched = word.exec(text)?.[0] ??
        PUNCTUATORS.find((punctuator) =>
          text.startsWith(punctuator, at) &&
          !(punctuator === "?." && /\d/.test(text[at + 2] ?? ""))
        ) ?? char;
      tokens.push(matched);
      at += matched.length;
    }
  }
  return tokens;
}

/**
 * Helper for {@link implementationMatches}, which reads an imported name
 * through the module alias the compiler writes on it.
 */
function withoutModuleAliases(tokens: readonly string[]): string[] {
  const alias = /^[A-Za-z_$][\w$]*_\d+$/;
  const result: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const [open, zero, comma, module, dot, name, close] = tokens.slice(
      at,
      at + 7,
    );
    if (
      open === "(" && zero === "0" && comma === "," && alias.test(module) &&
      dot === "." && isName(name) && close === ")"
    ) {
      result.push(name);
      at += 6;
    } else if (
      alias.test(tokens[at]) && tokens[at + 1] === "." &&
      isName(tokens[at + 2])
    ) {
      result.push(tokens[at + 2]);
      at += 2;
    } else {
      result.push(tokens[at]);
    }
  }
  return result;
}

/** Helper for {@link implementationMatches}, which drops trailing commas. */
function withoutTrailingCommas(tokens: readonly string[]): string[] {
  return tokens.filter((token, at) =>
    token !== "," ||
    !(tokens[at + 1] === ")" || tokens[at + 1] === "]" ||
      tokens[at + 1] === "}")
  );
}

/**
 * Helper for {@link implementationMatches}, which returns the index past the
 * type syntax starting at `authored[at]`, the next token then being `wanted`
 * where one is given, or `undefined` when no type syntax starts there.
 */
function afterTypeSyntax(
  authored: readonly string[],
  at: number,
  wanted: string | undefined,
  walk: DeclarationWalk,
): number | undefined {
  const token = authored[at];
  const previous = authored[at - 1];
  const enclosing = walk.open.length === 0
    ? undefined
    : authored[walk.open[walk.open.length - 1]];
  if (token === ":") {
    const ends = previous === ")" ? RETURN_TYPE_ENDS : enclosing === "(" &&
        (isName(previous) || previous === "}" || previous === "]" ||
          previous === "?")
      ? PARAMETER_TYPE_ENDS
      : declaresVariable(authored, at, walk)
      ? VARIABLE_TYPE_ENDS
      : undefined;
    return ends === undefined
      ? undefined
      : typeEnd(authored, at + 1, ends, wanted);
  }
  if (
    (token === "as" || token === "satisfies") && previous !== undefined &&
    (isName(previous) || /^[)\]}"'`\d]/.test(previous))
  ) {
    return typeEnd(authored, at + 1, ASSERTION_ENDS, wanted);
  }
  if (
    token === "?" && authored[at + 1] === ":" && enclosing === "(" &&
    isName(previous)
  ) {
    return at + 1;
  }
  if (
    token === "!" && wanted !== "!" &&
    (isName(previous) || previous === ")" || previous === "]")
  ) {
    return at + 1;
  }
  if (token === "<" && wanted === "(") {
    let depth = 0;
    for (let end = at; end < authored.length; end++) {
      if (authored[end] === "<") depth++;
      else if (/^>+$/.test(authored[end])) depth -= authored[end].length;
      if (depth === 0) return authored[end + 1] === "(" ? end + 1 : undefined;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

/**
 * Helper for {@link afterTypeSyntax}, which returns the index of the first
 * token outside brackets opened within the type that is in `ends`, provided it
 * is `wanted` where one is given.
 */
function typeEnd(
  authored: readonly string[],
  from: number,
  ends: ReadonlySet<string>,
  wanted: string | undefined,
): number | undefined {
  let depth = 0;
  for (let at = from; at < authored.length; at++) {
    const token = authored[at];
    if (depth === 0 && ends.has(token)) {
      return wanted === undefined || token === wanted ? at : undefined;
    }
    if (token === "(" || token === "[" || token === "{" || token === "<") {
      depth++;
    } else if (/^>+$/.test(token)) {
      depth -= token.length;
    } else if (token === ")" || token === "]" || token === "}") {
      depth--;
    }
    if (depth < 0) return undefined;
  }
  return undefined;
}

/**
 * Helper for {@link afterTypeSyntax}, which returns whether the `:` at `at`
 * annotates a variable: a name, or a destructuring pattern, just after
 * `const`, `let`, or `var`.
 */
function declaresVariable(
  authored: readonly string[],
  at: number,
  walk: DeclarationWalk,
): boolean {
  const previous = authored[at - 1];
  if (isName(previous)) return VARIABLE_KEYWORDS.has(authored[at - 2]);
  const opener = walk.opens.get(at - 1);
  return (previous === "}" || previous === "]") && opener !== undefined &&
    VARIABLE_KEYWORDS.has(authored[opener - 1]);
}

/** Helper for the token comparison, which tests for an identifier. */
function isName(token: string | undefined): token is string {
  return token !== undefined && /^[A-Za-z_$][\w$]*$/.test(token);
}
