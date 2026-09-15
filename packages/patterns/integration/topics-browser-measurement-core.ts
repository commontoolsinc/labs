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
   * The declaration's text from the function's start up to the module's next
   * top-level statement.
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
 * preview. A preview this long may end partway through an identifier.
 */
export const PREVIEW_LENGTH = 200;

/** Matches a run's `src`: the module identity, then `/<path>:<line>:<col>`. */
const SRC_PATTERN = /^cf:module\/([^/]+)(\/.+:\d+:\d+)$/;

/** Matches the start of a top-level statement at the beginning of a line. */
const TOP_LEVEL_START =
  /(?<=\n)(?:(?:export|const|let|var|function|async|class|interface|type|import)\b|\/\*\*|\/\/)/;

/**
 * Returns where the function argument of `name`'s module-scope
 * `const <name> = lift(<function>)` declaration starts in `text`, which is the
 * position the transformer records for a hoisted builder and the runtime
 * reports in each run's `src`, and the declaration's text from there. Comments
 * between the call's parenthesis and the function are skipped; type arguments
 * on `lift`, and a function passed after schema arguments, are not recognized.
 * The declaration's text ends at the next line opening with a top-level
 * statement, so a lift body holding such a line at column 0 is cut short.
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
 * Returns whether `preview`, the runner's copy of an implementation's emitted
 * source, can be the function `declaration` authors: each identifier of the
 * preview appears in the declaration, in order. Emitting a function removes
 * types and comments and adds nothing but module aliases on imported names,
 * which are read through. A preview {@link PREVIEW_LENGTH} long has its last
 * identifier dropped, since the cut may have split it.
 */
export function implementationMatches(
  preview: string,
  declaration: string,
): boolean {
  const unaliased = preview
    .replace(/\(0,\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\)/g, "$1")
    .replace(/\b[A-Za-z_$][\w$]*_\d+\.(?=[A-Za-z_$])/g, "");
  const wanted = identifiersOf(unaliased);
  if (preview.length >= PREVIEW_LENGTH) wanted.pop();
  const available = identifiersOf(declaration);
  let next = 0;
  for (const identifier of wanted) {
    while (next < available.length && available[next] !== identifier) next++;
    if (next === available.length) return false;
    next++;
  }
  return true;
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

/** Helper for {@link implementationMatches}, which lists identifiers in order. */
function identifiersOf(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}
