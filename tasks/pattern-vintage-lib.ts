/**
 * Stage 3 of the pattern-update regime: where a captured vintage LIVES.
 *
 * Tier 1 (`pattern-compat`) records a contract per pattern and proves the next
 * one is compatible with it. Tier 2 records a real prior STATE per pattern and
 * proves the next version can still read it. This module owns the fixture
 * layout the second one needs, and nothing else — capture and replay live in
 * `packages/piece/test/state-continuity-harness.ts`, the task shell in
 * `pattern-vintage.ts`.
 *
 * Layout:
 *
 *     packages/piece/test/vintages/<test key>/pinned/<iso>-<identity>.sqlite
 *     packages/piece/test/vintages/<test key>/pinned/<iso>-<identity>.sqlite.spaces/<did>.sqlite
 *
 * `<test key>` is the repo path under `packages/patterns/` of the TEST that
 * produced the fixture, so a fixture sits next to nothing and is found by path
 * alone. Keyed by test rather than by pattern because a test need not be named
 * after what it drives — `topics/main.tsx` is tested by `topics/topics.test.tsx`
 * — and one fixture routinely covers several patterns.
 *
 * The `.sqlite.spaces/` directory carries the run's OTHER spaces — a capture
 * that instantiates a pattern via `Factory.inSpace(...)` writes a second store,
 * and a fixture that held only the first would record roots whose state it does
 * not have. It is part of the FIXTURE, not a fixture itself, so
 * `parseVintagePath` declines everything inside one. Its shape lives in
 * `packages/piece/test/vintage-layout.ts`, which the snapshot/restore side needs
 * too and which is dependency-free so this module stays so.
 *
 * The tree is deliberately NOT under `packages/patterns/`, which is the
 * obvious home for it and the wrong one. `tasks/build-binaries.ts` passes that
 * whole directory to `deno compile --include`, which is recursive and takes
 * arbitrary non-source files — measured, and neither `deno.json`'s `exclude`
 * nor `.denoignore` filters it — so every fixture would be baked into the
 * shipped toolshed binary, and stage 4 accumulates fixtures. The same
 * directory is what `PatternsServer` serves by path, so they would also be
 * fetchable from any deployment. It lives beside the harness that reads it
 * instead.
 *
 * `<identity>` is PROVENANCE, not an address: it records which pattern version
 * wrote the state. Nothing looks a fixture up by it — the replay enumerates the
 * directory and replays everything it finds. That is deliberate. A gate that
 * selected fixtures by identity would silently cover nothing the moment the
 * naming drifted; enumeration cannot.
 *
 * `<iso>` is a capture timestamp, so retention can drop the oldest AUTO
 * captures without parsing anything (stage 4). Pinned vintages are never
 * dropped, which is why they live in their own directory rather than behind a
 * flag: a pruner is invoked by people doing something else, and a deep vintage
 * cannot be recaptured — the pattern that wrote it no longer exists in runnable
 * form.
 *
 * Fixtures are stored RAW, not gzipped, which is the opposite of what the
 * obvious reasoning suggests. A store is mostly slack (home.tsx is 3.5 MiB
 * across 99 revisions) and gzips 15x, so pre-compressing looks free — git
 * zlib-compresses blobs anyway.
 *
 * Measured, it is not free, because it defeats DELTA compression. Two captures
 * of home.tsx, packed into a fresh repo (`git init`, add, commit, `git gc`,
 * `git count-objects -vH`):
 *
 *     raw .sqlite     one 232.50 KiB   two 232.86 KiB   (+0.36 KiB)
 *     gzipped .gz     one 226.13 KiB   two 450.27 KiB   (+224 KiB)
 *
 * The second raw vintage is essentially free because git deltas it against the
 * first; two gzip streams delta not at all. Accumulating vintages is precisely
 * what stage 4 does, so the compounding term dominates the one-off.
 *
 * The cost is working-tree disk: 3.5 MiB a fixture rather than 226 KiB. That
 * is transient and local, where git history is permanent and shared by
 * everyone who clones.
 */

import { VINTAGE_SPACES_SUFFIX } from "../packages/piece/test/vintage-layout.ts";
import { resolveSystemPatternSource } from "@commonfabric/runner";

/** Root of the committed fixture tree. See the note above on why it is here. */
export const VINTAGES_DIR = "packages/piece/test/vintages";

/** Vintages that are never pruned and are the gate's real coverage. */
export const PINNED = "pinned";

/** Vintages captured automatically; retention drops the oldest (stage 4). */
export const AUTO = "auto";

export const VINTAGE_SUFFIX = ".sqlite";

export interface VintageRef {
  /**
   * TEST path relative to `packages/patterns/`, e.g. `system/home.test.tsx`.
   * Named for the test, not the pattern: the fixture covers whatever that
   * test instantiates, which is routinely several patterns.
   */
  testKey: string;
  /** `pinned` or `auto`. */
  tier: string;
  /** Capture timestamp, ISO-8601 with `:` replaced (filenames). */
  stamp: string;
  /** Identity of the pattern version that WROTE this state. */
  identity: string;
  /** Repo-relative path to the fixture file. */
  path: string;
}

/** The directory holding one TEST's fixtures of a given tier. */
export function vintageDir(testKey: string, tier: string): string {
  return `${VINTAGES_DIR}/${testKey}/${tier}`;
}

/**
 * `:` is legal in a POSIX filename and illegal on Windows, and an ISO
 * timestamp is full of them. Substituting keeps the name sortable — which is
 * the only property retention needs — without a platform caveat.
 */
export function stampFor(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

export function vintageFileName(stamp: string, identity: string): string {
  return `${stamp}-${identity}${VINTAGE_SUFFIX}`;
}

/**
 * `<stamp>-<identity>`, where the stamp is `stampFor`'s output (an ISO
 * timestamp with `:` substituted) and the identity is everything after it.
 * Both fields contain dashes, so the stamp's fixed shape is the only reliable
 * boundary between them.
 */
const NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)$/;

/**
 * Parse a fixture path back into its parts, or `undefined` if it is not one.
 *
 * Returning `undefined` rather than throwing is what lets the enumerator walk
 * a directory that also holds a README or a stray file without the gate dying
 * on it.
 *
 * `root` is a parameter, not the constant, so the layout can be exercised
 * against a temp tree. Anchoring it to the repo path instead is not a
 * theoretical smell: Tier 1's `isPatternSource` did exactly that, which
 * silently disabled every exclusion the moment it was handed an absolute path,
 * and the tests could not have caught it because they could not run anywhere
 * else.
 */
export function parseVintagePath(
  path: string,
  root: string = VINTAGES_DIR,
): VintageRef | undefined {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix) || !path.endsWith(VINTAGE_SUFFIX)) {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  const cut = rest.lastIndexOf("/");
  if (cut === -1) return undefined;
  const fileName = rest.slice(cut + 1);
  const dir = rest.slice(0, cut);
  // A companion store is PART of the fixture beside it, not a fixture of its
  // own. Declining it by name is deliberate rather than incidental: its filename
  // is a space DID, which would not parse as `<stamp>-<identity>` today, but a
  // gate that enumerated one as a separate vintage would replay a space against
  // a pattern key it never belonged to — and the reason it does not would be
  // invisible.
  if (dir.split("/").some((part) => part.endsWith(VINTAGE_SPACES_SUFFIX))) {
    return undefined;
  }
  const tierCut = dir.lastIndexOf("/");
  if (tierCut === -1) return undefined;
  const tier = dir.slice(tierCut + 1);
  const testKey = dir.slice(0, tierCut);
  if (testKey.length === 0 || tier.length === 0) return undefined;

  const base = fileName.slice(0, -VINTAGE_SUFFIX.length);
  // Anchor on the STAMP, which has a fixed shape, and take everything after it
  // as the identity. Neither field can be found by splitting on a dash: the
  // stamp contains them (`2026-07-29T16-40-22.484Z`) and so does a base64url
  // identity (`xaLUAd...vaXYy-P8PAkh...`). An earlier version cut at the LAST
  // dash and silently failed to recognise its own freshly-written fixture for
  // home.tsx — whose identity happens to contain one — reporting the pattern
  // as uncovered while the file sat right there.
  //
  // Requiring the stamp to match also rejects a non-fixture that merely ends
  // in the suffix, so the gate says "that is not a fixture" instead of trying
  // to replay it. Retention sorts on this field too (stage 4).
  const parsed = NAME_PATTERN.exec(base);
  if (parsed === null) return undefined;
  const [, stamp, identity] = parsed;

  return { testKey, tier, stamp, identity, path };
}

/** Every fixture under `root`, sorted by path so runs are reproducible. */
export async function collectVintages(
  root: string = VINTAGES_DIR,
): Promise<VintageRef[]> {
  const found: VintageRef[] = [];
  const walk = async (dir: string): Promise<void> => {
    try {
      // `Deno.readDir` returns a LAZY iterable: it does not touch the
      // filesystem until iteration, so a try/catch around the call alone
      // catches nothing and a missing tree escapes as ENOENT. The loop has to
      // be inside the try.
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(path);
          continue;
        }
        const ref = parseVintagePath(path, root);
        if (ref !== undefined) found.push(ref);
      }
    } catch (error) {
      // A missing tree is "no fixtures yet", not a failure — the gate reports
      // that as uncovered patterns, which is the actionable message.
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  };
  await walk(root);
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}

/**
 * Pattern keys that MUST have a pinned vintage.
 *
 * Derived from the runtime's own constants rather than a hand-kept list, so
 * the gate cannot drift from what actually auto-updates. These are the space
 * ROOTS: the runtime resolves their source pointer to a current identity and
 * swaps the pattern in place onto a root a user already has, with no structural
 * check on the way in. A change they cannot read bricks a live piece.
 *
 * Deliberately NOT "everything under `system/`". That directory also holds
 * personal variants (`*-ben.tsx`) and modules that are not patterns at all
 * (`piece-registry-migration.ts`), and requiring a vintage for those would
 * either wedge the gate on files that cannot be materialized or pad coverage
 * with fixtures nobody replays. Any other TEST can still be pinned
 * deliberately (`--update <test key>`) — a vintage that exists is always
 * replayed; it is only being REQUIRED that this list governs.
 */
const PATTERN_ROUTE_MARKER = "/patterns/";

/**
 * A recorded `main` as a path under `packages/patterns/`, or `undefined`.
 *
 * Two spellings reach a manifest and only one is a repo path. A pattern
 * imported locally records `/packages/patterns/x.tsx`; one loaded BY URL — as
 * `lunch-poll/main.tsx` does for `profile-create` — records the route the
 * toolshed serves it at, `/api/patterns/system/profile-create.tsx`. Resolving
 * the second against the repo root looks for `<repo>/api/patterns/...`, which
 * does not exist, and the replay reports a pattern that is right there as
 * unresolvable.
 *
 * The route prefix is the same `/patterns/` marker `requiredPatternKeys` keys
 * on, for the same reason: it is where `PatternsServer` mounts the directory.
 *
 * `patternsPrefix` is a parameter rather than a constant so the gate stays
 * exercisable against a temp tree — the suite's fixtures record
 * `/patterns/x.tsx`, the repo's record `/packages/patterns/x.tsx`, and a
 * hardcoded prefix would quietly make every synthetic fixture unmappable.
 */
export function patternKeyFromMain(
  main: string | undefined,
  patternsPrefix: string,
): string | undefined {
  if (main === undefined) return undefined;
  if (main.startsWith(patternsPrefix)) return main.slice(patternsPrefix.length);
  // The route EXACTLY, not "/api" plus the marker somewhere later. Matching
  // loosely turned `/api/anything/at/all/patterns/x.tsx` into the repo key
  // `x.tsx`, so an unrelated served path would resolve to a real source file
  // and be replayed as though it were that pattern — a wrong answer rather
  // than a refused one, which is the shape this gate must never produce.
  const route = "/api/patterns/";
  if (main.startsWith(route)) return main.slice(route.length);
  return undefined;
}

/**
 * The route a system pattern source names.
 *
 * The runtime's constants are `system:` refs, addressed relative to the
 * patterns route; the gate maps routes to fixture keys. A source that names no
 * route is handed back unchanged, so it reaches the unmapped check below rather
 * than disappearing from the required set.
 */
function patternRoute(source: string): string {
  return resolveSystemPatternSource(source) ?? source;
}

export function requiredPatternKeys(
  systemPatternUrls: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const source of systemPatternUrls) {
    const url = patternRoute(source);
    const at = url.indexOf(PATTERN_ROUTE_MARKER);
    if (at === -1) continue;
    keys.push(url.slice(at + PATTERN_ROUTE_MARKER.length));
  }
  return [...new Set(keys)].sort();
}

/**
 * The URLs `requiredPatternKeys` could not turn into a pattern key.
 *
 * `requiredPatternKeys` skips what it does not recognise, which is right for a
 * derivation and catastrophic for a gate: reroute the patterns endpoint and
 * every required key silently disappears, leaving a gate that insists on
 * nothing. The caller checks this and refuses to run rather than passing an
 * empty requirement, so a drift in the runtime's own constants is loud.
 */
export function unmappedPatternUrls(
  systemPatternUrls: readonly string[],
): string[] {
  return systemPatternUrls.filter((source) =>
    !patternRoute(source).includes(PATTERN_ROUTE_MARKER)
  );
}

/**
 * Required patterns that no fixture actually replayed.
 *
 * Judged from what the replay COVERED, not from the fixture tree's shape. A
 * fixture is named after the test that produced it and routinely covers several
 * patterns, so "a directory exists for X" and "X was replayed" are different
 * questions — and only the second is evidence.
 */
export function uncoveredRequiredPatterns(
  requiredKeys: readonly string[],
  covered: ReadonlySet<string>,
): string[] {
  return requiredKeys.filter((key) => !covered.has(key)).sort();
}

/** A vintage that could not be replayed under today's source. */
export interface ReplayFailure {
  /** The TEST whose fixture this failure came from. */
  testKey: string;
  /** Repo-relative fixture path. */
  path: string;
  detail: string;
}

/** A readable message for anything thrown across the task's I/O boundary. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An absolute path back to a repo-relative one, for readable output. */
export function relativeToRepo(path: string, repoRoot: string): string {
  const prefix = `${repoRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * What the gate prints when a pattern has no vintage.
 *
 * The report is the gate's entire interface to whoever trips it, so it is
 * built here and tested rather than assembled inline: a gate that fails with
 * an unclear message costs more than one that fails a little late.
 */
export function reportUncovered(
  uncovered: readonly string[],
  coveredBy: ReadonlyMap<string, { testKey: string; pinned: boolean }> =
    new Map(),
): string {
  // TWO situations, and the split is by the only fact this function reliably
  // has: does some fixture in the tree NAME this pattern.
  //
  // It used to split three ways, on the tier of the recording fixture. That
  // cost a defect every review round, for three reasons worth recording so it
  // is not rebuilt: the AUTO branch could not fire at all (nothing writes an
  // auto capture yet, so it was reachable only from a hand-built map); the
  // PINNED branch's whole content was a PROMISE about text it does not
  // control — "each failure below names its own remedy" — which was false for
  // three of the five failure shapes that reach it; and the third branch
  // merged "nothing records it" with "a fixture records it and could not be
  // read", whose remedies are opposites.
  //
  // The promise is now a fact instead: every fixture-level failure
  // interpolates its own `remedy`, so pointing at the failures is enough and
  // this function states nothing it cannot see. Re-add a tier branch when
  // something actually writes an auto capture, with a test that can reach it.
  const named = uncovered.filter((key) => coveredBy.has(key));
  const unnamed = uncovered.filter((key) => !coveredBy.has(key));
  return [
    `${uncovered.length} auto-updating pattern(s) are not covered by a pinned`,
    "vintage this run replayed:",
    "",
    ...uncovered.map((key) => {
      const from = coveredBy.get(key);
      return from === undefined
        ? `  ${key}`
        : `  ${key}  (recorded by ${from.testKey})`;
    }),
    "",
    "These patterns auto-update onto a root someone is already using, so a",
    "change that cannot read the old state bricks that piece.",
    ...(named.length > 0
      ? [
        "",
        "The ones with a test named ARE recorded by a fixture already in the",
        "tree, so capturing another would change nothing — its failure is",
        "printed below and carries the remedy for that particular fault.",
      ]
      : []),
    ...(unnamed.length > 0
      ? [
        "",
        "Nothing this run could READ names the rest. That is either a pattern",
        "no fixture covers, or a fixture too broken to say what it holds — the",
        "failures below tell which. For the first, capture the TEST that",
        "instantiates it, a test path rather than a pattern path because a",
        "fixture is produced by RUNNING a test:",
        "",
        "  deno task pattern-vintage --update <test path>",
        "",
        "e.g. `--update topics/topics.test.tsx`. Which test that is cannot be",
        "derived: a test need not be named after what it drives, and nothing",
        "on disk knows until a fixture exists.",
      ]
      : []),
  ].join("\n");
}

/** What the gate prints when a committed vintage no longer replays. */
export function reportFailures(failures: readonly ReplayFailure[]): string {
  return [
    `${failures.length} vintage(s) could not be replayed:`,
    "",
    ...failures.flatMap(({ testKey, path, detail }) => [
      `  ${testKey}`,
      `    ${path}`,
      `    ${detail}`,
    ]),
    "",
    "This is state a deployed piece is holding RIGHT NOW. The automatic updater",
    "performs no structural check, so nothing at runtime will stop this change",
    "from reaching it.",
  ].join("\n");
}

/**
 * What the gate prints when it PASSES — built here and tested, for the same
 * reason the failure reports are: it is the whole of what a green run tells
 * whoever reads the log, and a claim assembled inline is one nothing checks.
 *
 * "all mappable" is stated unconditionally and that is safe: `replayVintage`
 * reports every unaddressable root as a FAILURE and this line is only reached
 * once `isClean` has found none. Saying it positively rather than printing a
 * caveat beside a pass is the point — a green verdict with a footnote about
 * skipped roots is how narrowed coverage reads as success.
 *
 * `targets` sits beside `candidates` because the two differ, and the gap is the
 * honest measure of what was examined: a recorded instantiation is only an
 * upgrade target if today's source can be applied to it (a test pattern and a
 * keyless session pointer are neither). Stating only `candidates` would
 * overstate what a green run bought.
 */
export function reportReplaySummary(
  counts: {
    replayed: number;
    candidates: number;
    targets: number;
    changed: number;
    updated: number;
    servedRoute: number;
  },
): string {
  // Served routes are PRINTED, not merely counted. They are targets the run
  // deliberately did not identity-compare, so a summary that omitted them
  // described more coverage than the run bought — and the count existed for
  // exactly that reason while nothing displayed it.
  const served = counts.servedRoute > 0
    ? ` ${counts.servedRoute} target(s) were served routes and not ` +
      `identity-compared.`
    : "";
  return `Replayed ${counts.replayed} vintage(s): ${counts.candidates} ` +
    `recorded instantiation(s), all mappable to a file; ${counts.targets} ` +
    `upgrade target(s), ${counts.changed} changed since capture, ` +
    `${counts.updated} updated cleanly with no state stranded.${served}`;
}

/**
 * What `--update` prints when it was given no test to capture.
 *
 * There is deliberately no default set. A capture RUNS the named key as a
 * test, and the only moment a default would help is when a fixture is missing
 * — precisely when nothing on disk can say which test covers the pattern,
 * because a test need not be named after what it drives. A hand-kept list
 * looked like an answer and was a seam: the required PATTERNS derive from the
 * runtime's URL constants, so adding one that no listed test instantiates left
 * the gate red while this command reported everything fine and exited 0.
 */
export function reportUpdateNeedsATestKey(): string {
  return [
    "`--update` needs the TEST to capture, and was given none.",
    "",
    "  deno task pattern-vintage --update <test path>",
    "",
    "e.g. `--update topics/topics.test.tsx`. It is a test path, not a pattern",
    "path: a fixture is produced by RUNNING a test, and covers whatever that",
    "test instantiates — routinely several patterns, none of which need share",
    "its name.",
    "",
    `Every fixture already under ${VINTAGES_DIR}/ is replayed by`,
    "`deno task pattern-vintage` with no list anywhere, so a captured fixture",
    "is covered from the moment it is committed.",
  ].join("\n");
}

/** What the gate prints when it found no fixture to replay at all. */
export function reportNothingReplayed(): string {
  return [
    "Replayed 0 vintages — this gate covered NOTHING.",
    "",
    "A run that replays nothing proves nothing, so it is a failure rather than",
    "a pass. Either the fixture tree is missing (a bad checkout, or a path that",
    "moved without this task moving with it) or every file under it was",
    "declined as not a fixture. Capture one by naming the TEST that writes",
    "the state — a test path, not a pattern path, because a fixture is produced",
    "by RUNNING a test:",
    "",
    "  deno task pattern-vintage --update <test path>",
    "",
    "e.g. `--update system/home.test.tsx`. Bare `--update` captures nothing:",
    "there is no default set, because the one case a default would serve is a",
    "MISSING fixture, and nothing on disk knows which test covers a pattern",
    "whose fixture is gone.",
  ].join("\n");
}

/** What the gate prints when it cannot tell which patterns it must cover. */
export function reportUnmappedUrls(unmapped: readonly string[]): string {
  return [
    `${unmapped.length} system pattern URL(s) no longer name a pattern:`,
    "",
    ...unmapped.map((url) => `  ${url}`),
    "",
    "The required set is derived from these so the gate cannot drift from what",
    "actually auto-updates. A URL that no longer contains `/patterns/` derives",
    "nothing, which would leave the gate requiring nothing at all — so it stops",
    "here instead. Teach `requiredPatternKeys` the new route shape.",
  ].join("\n");
}

/**
 * What the gate prints when the process is about to end without a verdict.
 *
 * Measured, twice: a pattern that fails to compile and a truncated fixture BOTH
 * reject a promise nobody awaits while `harness.resolve()`'s own promise never
 * settles. `main` never reaches its verdict, the event loop drains, and the
 * process exits 0 having replayed nothing and printed nothing. A gate that goes
 * green because the thing it gates is too broken to test is worse than no gate,
 * so reaching a verdict is itself part of passing.
 */
export function reportNoVerdict(reason?: unknown): string {
  return [
    "The vintage gate ended without reaching a verdict.",
    "",
    "Something the replay awaited never settled — a pattern that does not",
    "compile and a corrupt fixture both do this, because the failure surfaces",
    "as an unhandled rejection while the promise stays pending forever. The",
    "gate proved nothing, so it fails.",
    "",
    reason === undefined
      ? "  (no rejection was observed; look for an unresolved await)"
      : `  last unhandled rejection: ${describeError(reason)}`,
  ].join("\n");
}

/**
 * Make "ended without a verdict" fail instead of pass.
 *
 * `beforeunload` fires when the event loop is about to drain, which is the last
 * moment at which a run that never finished is still distinguishable from one
 * that did. The caller's clean path exits explicitly, so anything that reaches
 * this listener did not get there.
 *
 * Takes its `target` and `exit` rather than reaching for `globalThis` and
 * `Deno.exit`, so the wiring itself is testable — the guard is the one piece of
 * this gate whose failure mode is silence, and an untested guard against
 * silence is a comment.
 */
export function armVerdictGuard(
  target: EventTarget,
  exit: (code: number) => void,
  log: (message: string) => void = console.error,
): void {
  let lastRejection: unknown;
  target.addEventListener("unhandledrejection", (event) => {
    lastRejection = (event as { reason?: unknown }).reason;
  });
  target.addEventListener("beforeunload", () => {
    log(reportNoVerdict(lastRejection));
    exit(1);
  });
}

/**
 * Whether the run passes. Split out so the exit condition is stated once and
 * tested, rather than being an `if` at the bottom of `main` that a later edit
 * can quietly invert — a gate that exits 0 on failure is worse than no gate.
 *
 * `counts.candidates` and `counts.targets` are the soundness floor, NOT the
 * number updated. A run where no pattern changed legitimately updates nothing,
 * which is the common case and the same condition the auto-updater fires on. A
 * run with no CANDIDATES examined no update targets at all — the shape that has
 * read as success three separate times in this tier's history. `targets` is the
 * same floor one step further in: recorded instantiations that today's source
 * cannot be applied to (a test pattern, a keyless session pointer) are not
 * coverage, so a run whose every candidate was one of those applied nothing
 * either, and must not read as a pass.
 *
 * `replayed` is part of the condition and not just a number to print: zero
 * replays is the shape a broken gate takes, not the shape a clean tree takes.
 */
export function isClean(
  failures: readonly ReplayFailure[],
  uncovered: readonly string[],
  counts: { replayed: number; candidates: number; targets: number },
): boolean {
  return failures.length === 0 && uncovered.length === 0 &&
    counts.replayed > 0 && counts.candidates > 0 && counts.targets > 0;
}
