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
 *     packages/patterns/vintages/<pattern key>/pinned/<iso>-<identity>.sqlite.gz
 *
 * `<pattern key>` is the pattern's repo path under `packages/patterns/`, so a
 * fixture sits next to nothing and is found by path alone.
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
 * Fixtures are stored gzipped. A space store is mostly slack (home.tsx is
 * 3.5 MiB across 99 revisions) and compresses 15-48x, so the compressed file is
 * what git would have stored anyway and the raw one is pure working-tree cost.
 */

import { PATTERNS_DIR } from "./pattern-files.ts";

/** Root of the committed fixture tree. */
export const VINTAGES_DIR = `${PATTERNS_DIR}/vintages`;

/** Vintages that are never pruned and are the gate's real coverage. */
export const PINNED = "pinned";

/** Vintages captured automatically; retention drops the oldest (stage 4). */
export const AUTO = "auto";

export const VINTAGE_SUFFIX = ".sqlite.gz";

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
 * deliberately — a vintage that exists is always replayed; it is only being
 * REQUIRED that this list governs.
 */
export function requiredPatternKeys(
  systemPatternUrls: readonly string[],
): string[] {
  const marker = "/patterns/";
  const keys: string[] = [];
  for (const url of systemPatternUrls) {
    const at = url.indexOf(marker);
    if (at === -1) continue;
    keys.push(url.slice(at + marker.length));
  }
  return [...new Set(keys)].sort();
}

/** Required patterns with no pinned vintage. */
export function uncoveredRequiredPatterns(
  requiredKeys: readonly string[],
  vintages: readonly VintageRef[],
): string[] {
  const covered = coveredPatternKeys(vintages);
  return requiredKeys.filter((key) => !covered.has(key)).sort();
}
