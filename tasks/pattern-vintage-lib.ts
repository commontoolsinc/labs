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

import { exists } from "@std/fs";
import {
  VINTAGE_SPACES_SUFFIX,
  vintageCompanionDir,
} from "../packages/piece/test/vintage-layout.ts";
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
 * How many generations of one test key the working tree keeps.
 *
 * A bound on CHECKOUTS, not on history. A vintage costs ~9 KiB of git history
 * per generation — packfile delta search makes adjacent generations of a
 * near-identical store nearly free — and 3.5 MiB of working-tree disk in every
 * clone, forever. Those are different orders of magnitude and only the second
 * one argues for a limit.
 *
 * Four is chosen to be small enough to matter on disk and large enough that a
 * key keeps a real span of history rather than just "the last one".
 */
export const AUTO_GENERATIONS_KEPT = 4;

/**
 * The AUTO fixtures to delete so no test key keeps more than `keep` of them.
 *
 * Pure, and returns paths rather than deleting, so the selection can be tested
 * without a filesystem — and so the one property that must never regress is
 * checkable by reading the return value: **it can only ever name a fixture
 * under an `auto/` directory.** That is not a rule written down and obeyed, it
 * is the shape of the function. The tier filter comes first, before any
 * sorting or slicing, so there is no ordering of the later steps that could
 * reach a pinned vintage.
 *
 * This matters more than it looks. A deep vintage cannot be recaptured — the
 * pattern that wrote it no longer exists in runnable form — and a pruner is
 * invoked by people who are doing something else and not reading its output.
 */
export function autoGenerationsToPrune(
  vintages: readonly VintageRef[],
  keep: number = AUTO_GENERATIONS_KEPT,
): string[] {
  const byKey = new Map<string, VintageRef[]>();
  for (const vintage of vintages) {
    if (vintage.tier !== AUTO) continue;
    const group = byKey.get(vintage.testKey);
    if (group === undefined) byKey.set(vintage.testKey, [vintage]);
    else group.push(vintage);
  }
  const doomed: string[] = [];
  for (const group of byKey.values()) {
    // Newest first, so the survivors are the newest `keep`. Sorted on the
    // STAMP rather than the path: both begin with the same directory, but a
    // path sort would order by identity once the stamps tie, and the stamp is
    // the only field that means age.
    const ordered = [...group].sort((left, right) =>
      right.stamp.localeCompare(left.stamp)
    );
    doomed.push(...ordered.slice(Math.max(keep, 0)).map((v) => v.path));
  }
  return doomed.sort();
}

/**
 * Delete pruned fixtures, refusing anything that is not an AUTO generation.
 *
 * The refusal is redundant with `autoGenerationsToPrune`, which structurally
 * cannot name a pinned fixture, and it stays anyway. This is the only code in
 * the repository that deletes a vintage, the thing it deletes cannot be
 * recreated, and the cost of the check is a string comparison. A second lock
 * on the one irreversible door is worth more than the line it costs.
 *
 * A companion directory goes with its primary file. It is part of the fixture
 * rather than a fixture of its own — nothing enumerates it — so leaving one
 * behind would strand a directory nothing will ever read or clean up again.
 */
export async function removeVintages(
  paths: readonly string[],
  root: string = VINTAGES_DIR,
): Promise<void> {
  for (const path of paths) {
    const ref = parseVintagePath(path, root);
    if (ref?.tier !== AUTO) {
      throw new Error(
        `refusing to prune ${path}: retention only ever deletes an ${AUTO} ` +
          `generation, and this is ${
            ref === undefined ? "not a vintage at all" : `tier ${ref.tier}`
          }`,
      );
    }
    await Deno.remove(path);
    await Deno.remove(vintageCompanionDir(path), { recursive: true })
      .catch(() => {});
  }
}

/**
 * The newest AUTO generation of one test key — what a release would promote.
 *
 * Promotion is the moment an auto capture stops being regenerable and starts
 * being evidence: a pinned vintage is never pruned and is the only tier that
 * credits coverage. Picking the NEWEST is the point — it is the generation
 * closest to what shipped, and the one whose successor will have the most to
 * migrate across.
 */
export function newestAutoGeneration(
  vintages: readonly VintageRef[],
  testKey: string,
): VintageRef | undefined {
  return vintages
    .filter((v) => v.tier === AUTO && v.testKey === testKey)
    .sort((left, right) => right.stamp.localeCompare(left.stamp))[0];
}

/**
 * Where a promoted fixture lands: the same name, under `pinned/`.
 *
 * The stamp and identity are carried over UNCHANGED, so a promoted vintage
 * still records when it was captured and by which test — restamping it would
 * date the promotion instead, and the capture date is what says which
 * generation of the world it holds.
 */
export function promotedPath(ref: VintageRef): string {
  const cut = ref.path.lastIndexOf("/");
  const fileName = ref.path.slice(cut + 1);
  const upToTier = ref.path.slice(0, cut);
  const tierCut = upToTier.lastIndexOf("/");
  return `${upToTier.slice(0, tierCut)}/${PINNED}/${fileName}`;
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
 * Promote an AUTO generation to `pinned/`, with `git mv`.
 *
 * `git mv` rather than a plain rename, because the point of promotion is that
 * the move lands in a COMMIT: a release promotes a fixture out of the prunable
 * tier so retention can never reach it, and a rename git has not been told
 * about shows up as a delete plus an add — which is exactly the diff that
 * looks like someone destroying a vintage, in a tree whose append-only
 * discipline rests on people reading diffs.
 *
 * The companion directory moves too, and moves FIRST. If the pair is going to
 * be split by an interrupted promotion, the survivable order is the one that
 * leaves the primary file where the enumerator still finds it: a fixture whose
 * companion has moved out from under it fails loudly on the next replay, where
 * a companion orphaned beside a moved primary is invisible.
 */
export async function promoteVintage(ref: VintageRef): Promise<string> {
  const destination = promotedPath(ref);
  await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
    recursive: true,
  });
  const companion = vintageCompanionDir(ref.path);
  if (await exists(companion)) {
    await gitMove(companion, vintageCompanionDir(destination));
  }
  await gitMove(ref.path, destination);
  return destination;
}

/**
 * `git mv`, falling back to a plain rename for anything git does not track.
 *
 * The fallback is not defensive tidiness, it is the common case. A generation
 * captured minutes ago is UNTRACKED, and capture-then-promote in one sitting is
 * the most natural first use of these two commands. Measured, not reasoned
 * about: the first real `--pin` run died on exactly this.
 *
 * Where the fixture IS tracked, `git mv` is what runs, because there the staged
 * rename is the entire point — renaming a committed fixture behind git's back
 * reads in review as a delete plus an add, which is the diff that looks like
 * someone destroying a vintage.
 *
 * Which of the two applies is decided by ASKING git, rather than by matching
 * its error text. The first attempt matched on "not under version control" and
 * was wrong twice over: `git mv` resolves the repository from the process's
 * working directory rather than the file's, so the same untracked fixture
 * produces a different message ("is outside repository") depending on where
 * the command was invoked from — and every unmatched message became a crash.
 * `cwd` is pinned to the fixture's own directory for the same reason.
 */
async function gitMove(from: string, to: string): Promise<void> {
  const cwd = from.slice(0, from.lastIndexOf("/"));
  const tracked = await new Deno.Command("git", {
    args: ["ls-files", "--error-unmatch", from],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!tracked.success) {
    // Untracked, or not in a repository at all. Either way there is no index
    // entry to move, so the rename IS the whole operation.
    await Deno.rename(from, to);
    return;
  }
  const result = await new Deno.Command("git", {
    args: ["mv", from, to],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git mv ${from} ${to} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
}

/**
 * Everything a command wants to say, and the code it wants to exit with.
 *
 * Returned rather than printed so the OUTPUT is testable, not just the
 * decision behind it. That is where this file's defects have actually lived:
 * across five review rounds the recurring fault was never a wrong decision, it
 * was the wrong text printed for a correct one — a remedy that did not fit the
 * situation, or a promise about output the function did not control. Text
 * assembled inside the task shell is text no test can read.
 */
export interface CommandOutput {
  out?: string;
  err?: string;
  code: number;
}

/** What `--pin` says, given what it decided. */
export function describePinOutcome(
  outcome:
    | { kind: "needs-one-key"; given: number }
    | {
      kind: "nothing-to-pin";
      testKey: string;
      vintages: readonly VintageRef[];
    }
    | { kind: "promoted"; from: string; to: string }
    | { kind: "failed"; from: string; detail: string },
  repoRoot: string,
): CommandOutput {
  switch (outcome.kind) {
    case "needs-one-key":
      return { err: reportPinNeedsOneTestKey(outcome.given), code: 1 };
    case "nothing-to-pin":
      return {
        err: reportNothingToPin(outcome.testKey, outcome.vintages),
        code: 1,
      };
    case "failed":
      return {
        err: `Could not promote ${
          relativeToRepo(outcome.from, repoRoot)
        }: ${outcome.detail}`,
        code: 1,
      };
    case "promoted":
      return {
        out: [
          `  ${relativeToRepo(outcome.from, repoRoot)}`,
          `  → ${relativeToRepo(outcome.to, repoRoot)}`,
        ].join("\n"),
        code: 0,
      };
  }
}

/** What `--capture-changed` says, given what it decided. */
export function describeCaptureOutcome(
  outcome:
    | { kind: "refused-red"; failures: readonly ReplayFailure[] }
    | { kind: "all-current"; replayed: number }
    | {
      kind: "captured";
      captured: readonly string[];
      pruned: readonly string[];
      problems: readonly string[];
    },
  repoRoot: string,
): CommandOutput {
  switch (outcome.kind) {
    case "refused-red":
      return {
        err: `\n${reportFailures(outcome.failures)}\n\n${
          reportCaptureRefusedOnRed(outcome.failures.length)
        }`,
        code: 1,
      };
    case "all-current":
      return { out: reportEveryGenerationCurrent(outcome.replayed), code: 0 };
    case "captured": {
      const out = [
        ...outcome.captured.map((p) => `  + ${relativeToRepo(p, repoRoot)}`),
        ...outcome.pruned.map((p) => `  - ${relativeToRepo(p, repoRoot)}`),
      ].join("\n");
      // A capture that partly failed still REPORTS what it wrote, then exits
      // 1. Suppressing the list would leave files on disk that the command
      // just claimed not to have made.
      return outcome.problems.length > 0
        ? {
          out,
          err:
            `\n${outcome.problems.length} generation(s) were not captured:\n${
              outcome.problems.join("\n")
            }`,
          code: 1,
        }
        : { out, code: 0 };
    }
  }
}

/** What `--pin` prints when it was not given exactly one test key. */
export function reportPinNeedsOneTestKey(given: number): string {
  return [
    given === 0
      ? "`--pin` names the TEST whose newest auto generation to promote."
      : `\`--pin\` promotes one test key at a time; ${given} were named.`,
    "",
    "  deno task pattern-vintage --pin topics/topics.test.tsx",
    "",
    "Promotion is a deliberate act per fixture — it moves a generation into",
    "the tier retention can never reach, and pinning a batch by accident is",
    "not undone by pinning less next time.",
  ].join("\n");
}

/** What `--pin` prints when a key has no auto generation to promote. */
export function reportNothingToPin(
  testKey: string,
  vintages: readonly VintageRef[],
): string {
  const keys = [
    ...new Set(vintages.filter((v) => v.tier === AUTO).map((v) => v.testKey)),
  ].sort();
  const alreadyPinned = vintages.some(
    (v) => v.tier === PINNED && v.testKey === testKey,
  );
  return [
    `No ${AUTO} generation of ${testKey} to promote.`,
    "",
    ...(alreadyPinned
      ? [
        `${testKey} already has a pinned vintage, and promotion only ever`,
        "moves a generation the automatic capture produced. To pin a NEWER",
        "one, capture it first:",
        "",
        "  deno task pattern-vintage --capture-changed",
        "",
        "which captures only where today's source has moved past every",
        "generation on disk — so it does nothing if this key is current.",
      ]
      : keys.length === 0
      ? [
        "Nothing in the tree has one. Auto generations are captured by:",
        "",
        "  deno task pattern-vintage --capture-changed",
      ]
      : [
        "Keys that do have one:",
        "",
        ...keys.map((key) => `  ${key}`),
      ]),
  ].join("\n");
}

/** What `--capture-changed` prints when it will not capture onto a red tree. */
export function reportCaptureRefusedOnRed(failures: number): string {
  return [
    `Captured nothing: ${failures} fixture(s) failed to replay.`,
    "",
    "A generation is a record of a world that WORKED. Capturing beside a",
    "failure would mint one from a run whose verdict is red, and the fixture",
    "would then be replayed by everyone else as though it were evidence.",
    "",
    "Fix the failures above, or delete the fixture that can no longer replay",
    "— deliberately, so it shows up in the diff — and run this again.",
  ].join("\n");
}

/** What `--capture-changed` prints when no key needs a new generation. */
export function reportEveryGenerationCurrent(replayed: number): string {
  return [
    `Captured nothing: all ${replayed} fixture(s) are current.`,
    "",
    "Every target each fixture recorded still compiles to the identity it",
    "captured, so a fresh capture would record the same world and cost a file",
    "to say so.",
  ].join("\n");
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
  failedTestKeys: ReadonlySet<string> = new Set(),
): string {
  // Every branch below is chosen from a fact this function was HANDED, never
  // from one it infers about output it does not control. That distinction is
  // the whole design of this report, and it was arrived at expensively: across
  // four review rounds the recurring defect was always the same shape — a
  // remedy printed for a situation it did not fit — and always because the
  // text was reasoning about something out of frame.
  //
  // The last version got as far as refusing to guess: it listed BOTH possible
  // remedies and told the reader to work out which applied from the failures
  // printed below. Honest, and still the reader's problem to solve. `failures`
  // carries a `testKey`, so which fixtures failed is knowable here — and once
  // known, each pattern gets the one remedy that fits it.
  //
  // Three situations, and each is a question with an answer in hand: does a
  // fixture NAME this pattern (`coveredBy`), did that fixture FAIL
  // (`failedTestKeys`), and is it the tier that credits coverage (`pinned`).
  const named = uncovered.filter((key) => coveredBy.has(key));
  const unnamed = uncovered.filter((key) => !coveredBy.has(key));
  const broken = named.filter((key) =>
    failedTestKeys.has(coveredBy.get(key)!.testKey)
  );
  // Recorded by an AUTO generation that replayed FINE. The generation is real
  // and it works; it just does not credit coverage, because retention can
  // delete it and coverage that retention can delete is not coverage. The
  // remedy is to move it into the tier retention cannot reach.
  const promotable = named.filter((key) =>
    !failedTestKeys.has(coveredBy.get(key)!.testKey) &&
    !coveredBy.get(key)!.pinned
  );
  // Recorded by a PINNED fixture that replayed without failing, and still not
  // credited. Deliberately NOT given a remedy: every route to it that can be
  // named ends in a failure, so reaching it means the gate's own accounting
  // disagrees with itself, and any instruction printed here would be a guess
  // about a state whose cause is unknown. Saying so is the useful output.
  const unexplained = named.filter((key) =>
    !failedTestKeys.has(coveredBy.get(key)!.testKey) &&
    coveredBy.get(key)!.pinned
  );
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
    ...(broken.length > 0
      ? [
        "",
        "Recorded by a fixture that FAILED this run. The failure printed below",
        "carries the remedy for that particular fault; capturing another",
        "fixture would change nothing:",
        "",
        ...broken.map((key) => `  ${key}  ${coveredBy.get(key)!.testKey}`),
      ]
      : []),
    ...(promotable.length > 0
      ? [
        "",
        `Recorded by an ${AUTO} generation that replayed cleanly. Auto`,
        "generations are pruned by count, so letting one credit coverage would",
        "let retention delete a pattern's only evidence. Promote it:",
        "",
        ...[...new Set(promotable.map((key) => coveredBy.get(key)!.testKey))]
          .map((testKey) => `  deno task pattern-vintage --pin ${testKey}`),
      ]
      : []),
    ...(unexplained.length > 0
      ? [
        "",
        "Recorded by a PINNED fixture that replayed without failing, and still",
        "not credited. No remedy is printed because there is no known route to",
        "this state — the gate's own accounting is disagreeing with itself, and",
        "an instruction here would be a guess. Worth reporting as a gate bug:",
        "",
        ...unexplained.map((key) => `  ${key}  ${coveredBy.get(key)!.testKey}`),
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
