/**
 * Contract shape of the session-local handle table: short opaque tokens that
 * stand in for cell addresses in model-visible text, so a transcript never
 * has to carry a full LLM-friendly link. Shapes and token grammar only — the
 * minting and swapping machinery lives in `../handle-table.ts`.
 */

/** Discriminator value of a {@link HarnessHandleTable}. */
export const HARNESS_HANDLE_TABLE_TYPE = "cf-harness.handle-table";

/**
 * Referent category of a handle. Only cell addresses are representable; the
 * token grammar reserves a distinct `cfh:v:` prefix so a value kind can be
 * added without re-reading existing tokens.
 */
export type HarnessHandleKind = "address";

/** Prefix of every address-handle token (`cfh:a:<suffix>`). */
export const ADDRESS_HANDLE_TOKEN_PREFIX = "cfh:a:";

/**
 * Alphabet a token suffix is drawn from: the digits `2`-`9` and the lowercase
 * letters minus `i`, `l`, `o`, and `u` — 30 characters with no
 * easily-confused glyphs, so a token survives being retyped.
 */
export const HANDLE_TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";

/** Smallest number of alphabet characters in a token suffix. */
export const MIN_HANDLE_TOKEN_SUFFIX_LENGTH = 5;

/**
 * Matches address-handle tokens in free text: `cfh:a:` followed by five or
 * more {@link HANDLE_TOKEN_ALPHABET} characters. Global, and therefore
 * stateful under `exec()` — take a fresh copy via
 * `new RegExp(HANDLE_TOKEN_PATTERN)` where a shared `lastIndex` could leak
 * between calls.
 */
export const HANDLE_TOKEN_PATTERN = new RegExp(
  `cfh:a:[${HANDLE_TOKEN_ALPHABET}]{${MIN_HANDLE_TOKEN_SUFFIX_LENGTH},}`,
  "g",
);

/**
 * One handle: a token and the address it stands for.
 */
export interface HarnessHandleEntry {
  /** The full token, prefix included (`cfh:a:<suffix>`). */
  token: string;
  kind: HarnessHandleKind;
  /**
   * Canonical LLM-friendly link string of the referent — the
   * `/[@did/]<id>[@scope][/path]` form serialized by the runner's
   * `createLLMFriendlyLink()`, so two spellings of one address share one
   * `ref`.
   */
  ref: string;
  /**
   * The runner's `addressKey()` of the referent's normalized link. Entry
   * identity: minting the same address twice returns the existing token.
   */
  addressKey: string;
}

/**
 * The session-local handle table. `salt` is the owning run's id, fixed at
 * creation, so token derivation is deterministic within a run and disjoint
 * across runs.
 */
export interface HarnessHandleTable {
  type: typeof HARNESS_HANDLE_TABLE_TYPE;
  version: 1;
  salt: string;
  entries: HarnessHandleEntry[];
}
