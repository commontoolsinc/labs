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
 *     packages/piece/test/vintages/<pattern key>/pinned/<iso>-<identity>.sqlite
 *     packages/piece/test/vintages/<pattern key>/pinned/<iso>-<identity>.sqlite.spaces/<did>.sqlite
 *
 * `<pattern key>` is the pattern's repo path under `packages/patterns/`, so a
 * fixture sits next to nothing and is found by path alone.
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

/** Root of the committed fixture tree. See the note above on why it is here. */
export const VINTAGES_DIR = "packages/piece/test/vintages";

/** Vintages that are never pruned and are the gate's real coverage. */
export const PINNED = "pinned";

/** Vintages captured automatically; retention drops the oldest (stage 4). */
export const AUTO = "auto";

export const VINTAGE_SUFFIX = ".sqlite";

export interface VintageRef {
  /** Pattern path relative to `packages/patterns/`, e.g. `system/home.tsx`. */
  patternKey: string;
  /** `pinned` or `auto`. */
  tier: string;
  /** Capture timestamp, ISO-8601 with `:` replaced (filenames). */
  stamp: string;
  /** Identity of the pattern version that WROTE this state. */
  identity: string;
  /** Repo-relative path to the fixture file. */
  path: string;
}

/** The directory holding one pattern's fixtures of a given tier. */
export function vintageDir(patternKey: string, tier: string): string {
  return `${VINTAGES_DIR}/${patternKey}/${tier}`;
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
  const patternKey = dir.slice(0, tierCut);
  if (patternKey.length === 0 || tier.length === 0) return undefined;

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

  return { patternKey, tier, stamp, identity, path };
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

/** Pattern keys with at least one PINNED vintage. */
export function coveredPatternKeys(
  vintages: readonly VintageRef[],
): Set<string> {
  const covered = new Set<string>();
  for (const vintage of vintages) {
    if (vintage.tier === PINNED) covered.add(vintage.patternKey);
  }
  return covered;
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
 * with fixtures nobody replays. Any other pattern can still be pinned
 * deliberately (`--update <pattern key>`) — a vintage that exists is always
 * replayed; it is only being REQUIRED that this list governs.
 */
const PATTERN_ROUTE_MARKER = "/patterns/";

export function requiredPatternKeys(
  systemPatternUrls: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const url of systemPatternUrls) {
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
  return systemPatternUrls.filter((url) => !url.includes(PATTERN_ROUTE_MARKER));
}

/** Required patterns with no pinned vintage. */
export function uncoveredRequiredPatterns(
  requiredKeys: readonly string[],
  vintages: readonly VintageRef[],
): string[] {
  const covered = coveredPatternKeys(vintages);
  return requiredKeys.filter((key) => !covered.has(key)).sort();
}

/** A vintage that could not be replayed under today's source. */
export interface ReplayFailure {
  patternKey: string;
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
export function reportUncovered(uncovered: readonly string[]): string {
  return [
    `${uncovered.length} auto-updating pattern(s) have no pinned vintage:`,
    "",
    ...uncovered.map((key) => `  ${key}`),
    "",
    "These patterns auto-update onto a root someone is already using, so a",
    "change that cannot read the old state bricks that piece. Capture one with:",
    "",
    "  deno task pattern-vintage --update",
  ].join("\n");
}

/** What the gate prints when a committed vintage no longer replays. */
export function reportFailures(failures: readonly ReplayFailure[]): string {
  return [
    `${failures.length} vintage(s) could not be replayed:`,
    "",
    ...failures.flatMap(({ patternKey, path, detail }) => [
      `  ${patternKey}`,
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
  },
): string {
  return `Replayed ${counts.replayed} vintage(s): ${counts.candidates} ` +
    `recorded instantiation(s), all mappable to a file; ${counts.targets} ` +
    `upgrade target(s), ${counts.changed} changed since capture, ` +
    `${counts.updated} updated cleanly with no state stranded.`;
}

/** What the gate prints when it found no fixture to replay at all. */
export function reportNothingReplayed(): string {
  return [
    "Replayed 0 vintages — this gate covered NOTHING.",
    "",
    "A run that replays nothing proves nothing, so it is a failure rather than",
    "a pass. Either the fixture tree is missing (a bad checkout, or a path that",
    "moved without this task moving with it) or every file under it was",
    "declined as not a fixture. Capture one with:",
    "",
    "  deno task pattern-vintage --update",
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
