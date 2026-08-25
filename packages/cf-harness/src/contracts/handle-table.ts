/**
 * Contract shape of the session-local handle table: short opaque tokens that
 * stand in for cell addresses in model-visible text, so a transcript never
 * has to carry a full LLM-friendly link. Shapes and token grammar only — the
 * minting and swapping machinery lives in `../handle-table.ts`.
 */

import type { JSONSchema } from "@commonfabric/api";

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

/**
 * Number of alphabet characters in every minted token suffix. Minting is
 * fixed-width: a suffix collision re-derives a fresh five-character suffix
 * rather than extending the token, so no token is a prefix of another.
 */
export const MIN_HANDLE_TOKEN_SUFFIX_LENGTH = 5;

/**
 * Matches address-handle tokens in free text: `cfh:a:` followed by five or
 * more {@link HANDLE_TOKEN_ALPHABET} characters. Detection deliberately stays
 * open-ended even though minted suffixes are exactly five characters: a
 * longer alphabet run swallowed whole resolves to no entry and passes through
 * unknown, so a token abutting alphabet text is never substituted inside it.
 * Global, and therefore stateful under `exec()` — take a fresh copy via
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
  /**
   * Shape of the value at the referent, when a mint knew it — the compiled
   * pattern's result schema behind a `run_pattern` result reference. Absent
   * means the shape was never free to capture, not that the referent has none:
   * no mint reads the cell to fill this in.
   */
  schema?: JSONSchema;
  /**
   * Where {@link HarnessHandleEntry.schema} came from. `harness` means a
   * harness step supplied it out of its own work — the schema a pattern WE
   * compiled and ran declares — which is the only provenance a mint records.
   *
   * A schema is disclosed to a model only under that provenance. The
   * difference is not fussiness: a schema that arrived with data is data, and
   * property names are a channel wide enough to carry whatever whoever wrote
   * them wanted said. An entry whose schema has no provenance — one adopted
   * from state this code did not write — reads as shapeless rather than as
   * trusted.
   */
  schemaSource?: "harness";
}

/**
 * The session-local handle table. `salt` is the owning run's id, fixed at
 * creation, so token derivation is deterministic within a run and disjoint
 * across runs. The version stays `1` across the optional
 * {@link HarnessHandleEntry.schema}: an entry without one is well-formed, so
 * a table persisted before schemas were captured loads unchanged.
 */
export interface HarnessHandleTable {
  type: typeof HARNESS_HANDLE_TABLE_TYPE;
  version: 1;
  salt: string;
  entries: HarnessHandleEntry[];
}
