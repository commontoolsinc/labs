/**
 * Minting and swapping machinery for the session-local handle table declared
 * in `./contracts/handle-table.ts`: derives tokens for cell addresses,
 * replaces address occurrences in model-bound values with those tokens, and
 * replaces tokens in model-produced values with the canonical address
 * strings. Pure functions over the table value — nothing here reads or
 * writes state, and swapping never throws on text it cannot parse.
 */

import { sha256 } from "@commonfabric/content-hash";
import {
  ENTITY_URI_SCHEMES,
  hasEntityUriScheme,
} from "@commonfabric/runner/entity-kind";
import {
  addressKey,
  createLLMFriendlyLink,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_ALPHABET,
  HANDLE_TOKEN_PATTERN,
  HARNESS_HANDLE_TABLE_TYPE,
  type HarnessHandleEntry,
  type HarnessHandleTable,
  MIN_HANDLE_TOKEN_SUFFIX_LENGTH,
} from "./contracts/handle-table.ts";

/**
 * Digest function used to derive token suffixes. A seam for tests that need
 * to force a suffix collision; production callers leave it defaulted to
 * SHA-256.
 */
export type HandleTokenHasher = (
  input: Uint8Array<ArrayBuffer>,
) => Promise<Uint8Array<ArrayBuffer>>;

// The canonical SHA-256 from `@commonfabric/content-hash`, wrapped to fit the
// async hasher seam.
const sha256Hasher: HandleTokenHasher = (input) =>
  Promise.resolve(sha256(input) as Uint8Array<ArrayBuffer>);

/**
 * Context space handed to `createLLMFriendlyLink()` when a link carries its
 * own space: the serializer embeds a link's space DID only when it differs
 * from the context, and the handle table has no execution space of its own,
 * so every carried DID must survive into the canonical `ref`.
 */
const HANDLE_REF_CONTEXT_SPACE =
  "did:cf-harness:handle-table" as NormalizedFullLink["space"];

/**
 * Normalizes `refText` — an LLM-friendly link string, or a bare `of:`- or
 * `computed:`-schemed entity URI — to a normalized link. A ref with no
 * embedded space DID yields a link without `space`; the two operations
 * applied to the result tolerate that (`addressKey()` serializes the absence
 * deterministically, and `createLLMFriendlyLink()` omits the DID), which is
 * what the cast relies on.
 *
 * @throws Error when the text does not parse, or names an id outside the
 * entity URI schemes (a bare hash, an `opaque:` handle, a human name).
 */
const normalizeHandleRef = (refText: string): NormalizedFullLink => {
  const trimmed = refText.trim();
  const parsed = parseLLMFriendlyLink(
    trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
  );
  if (parsed.id === undefined || !hasEntityUriScheme(parsed.id)) {
    throw new Error(
      `Handle refs must name an entity URI (\`of:\`/\`computed:\`): \`${refText}\``,
    );
  }
  return {
    id: parsed.id,
    path: parsed.path,
    scope: parsed.scope ?? "space",
    ...(parsed.space !== undefined ? { space: parsed.space } : {}),
  } as NormalizedFullLink;
};

/** Helper for minting, which serializes a link to its canonical `ref`. */
const canonicalRef = (link: NormalizedFullLink): string =>
  createLLMFriendlyLink(
    link,
    link.space === undefined ? undefined : HANDLE_REF_CONTEXT_SPACE,
  );

/**
 * Helper for minting, which derives one fixed-width token suffix: SHA-256 of
 * `<salt>\0<addressKey>` (or `<salt>\0<addressKey>\0<attempt>` for attempts
 * past the first) mapped byte-by-byte into the alphabet. Every suffix is
 * exactly {@link MIN_HANDLE_TOKEN_SUFFIX_LENGTH} characters, so no token can
 * be a prefix of another.
 */
const deriveTokenSuffix = async (
  salt: string,
  key: string,
  attempt: number,
  hasher: HandleTokenHasher,
): Promise<string> => {
  const preimage = attempt === 0
    ? `${salt}\0${key}`
    : `${salt}\0${key}\0${attempt}`;
  const digest = await hasher(new TextEncoder().encode(preimage));
  let suffix = "";
  for (const byte of digest.subarray(0, MIN_HANDLE_TOKEN_SUFFIX_LENGTH)) {
    suffix += HANDLE_TOKEN_ALPHABET[byte % HANDLE_TOKEN_ALPHABET.length];
  }
  return suffix;
};

/**
 * Copies `key` onto `target` as an own data property. Assignment would
 * install an own `__proto__` key as the object's prototype; a define keeps it
 * data, so the deep walkers here and in the prompt loop cannot be steered
 * into prototype pollution by hostile tool output.
 */
export const defineOwnEntry = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/** Constructs an empty handle table salted with `salt` (the run id). */
export const createHarnessHandleTable = (
  salt: string,
): HarnessHandleTable => ({
  type: HARNESS_HANDLE_TABLE_TYPE,
  version: 1,
  salt,
  entries: [],
});

/**
 * Mints an address handle for `refText`, returning the updated table and the
 * token. Minting is idempotent per address: two spellings of one address —
 * an LLM-friendly link and the bare entity URI, say — normalize to the same
 * `addressKey` and share one token. The token suffix is derived
 * deterministically from the table's salt and the address, always exactly
 * {@link MIN_HANDLE_TOKEN_SUFFIX_LENGTH} characters; while the suffix
 * collides with a token already held by a different address, a fresh suffix
 * is re-derived with an attempt counter mixed into the hash preimage.
 *
 * @throws Error when `refText` does not name an entity address; see
 * `swapLinksForTokens()` for the swallow-and-skip caller.
 */
export const mintAddressHandle = async (
  table: HarnessHandleTable,
  refText: string,
  hasher: HandleTokenHasher = sha256Hasher,
): Promise<{ table: HarnessHandleTable; token: string }> => {
  const link = normalizeHandleRef(refText);
  const key = addressKey(link);
  const existing = table.entries.find((entry) => entry.addressKey === key);
  if (existing !== undefined) {
    return { table, token: existing.token };
  }
  let attempt = 0;
  let suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  // Any table entry holding the candidate token has a different addressKey —
  // the same key returned above — so each hit means a genuine collision.
  while (
    table.entries.some(
      (entry) => entry.token === ADDRESS_HANDLE_TOKEN_PREFIX + suffix,
    )
  ) {
    attempt += 1;
    suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  }
  const entry: HarnessHandleEntry = {
    token: ADDRESS_HANDLE_TOKEN_PREFIX + suffix,
    kind: "address",
    ref: canonicalRef(link),
    addressKey: key,
  };
  return {
    table: { ...table, entries: [...table.entries, entry] },
    token: entry.token,
  };
};

/** Returns the entry holding `token`, or `undefined` when none does. */
export const resolveHandleToken = (
  table: HarnessHandleTable,
  token: string,
): HarnessHandleEntry | undefined =>
  table.entries.find((entry) => entry.token === token);

// The free-text address grammar, assembled from the entity URI schemes so a
// new scheme cannot leave a stale alternation here. The scheme prefix is the
// sole positive marker; after it, any `<tag>:<base64url-ish>` tagged hash is
// accepted (`fid1` today, whatever `FabricHash` tags come later), and the
// runner's parser decides whether the occurrence is a real address. A bare
// tagged hash (`fid1:<hash>` with no scheme) is deliberately unmatchable:
// schema hashes, blob ids, and slugs share that encoding, so only the schemed
// forms are positively an address.
const HASH_CHAR = "[A-Za-z0-9_-]";
const ENTITY_ID_SOURCE = `(?:${
  ENTITY_URI_SCHEMES.join("|")
}):[A-Za-z0-9]+:${HASH_CHAR}+`;
// A path segment ends at whitespace, quotes, backticks, or closing
// punctuation, so an address at the end of a sentence does not swallow it.
const PATH_SEGMENT_SOURCE = `[^/\\s"'\`\\)\\]\\}>,;]+`;
const LINK_OCCURRENCE_SOURCE =
  // An optional cross-space prefix ending in `/`, or a bare leading `/`.
  `((?:/@did:[^/\\s]+)?/)?` +
  // At a word boundary: when the leading `/` is present the lookbehind sees
  // it and passes; when absent it keeps `proof:fid1:…` and `x-of:fid1:…`
  // from half-matching.
  `(?<![A-Za-z0-9_:.@-])` +
  `${ENTITY_ID_SOURCE}` +
  // `@space` is consumed too: it is the default scope, so the canonical
  // serialization of the minted ref simply drops it.
  `(?:@(?:user|session|space))?` +
  `((?:/${PATH_SEGMENT_SOURCE})*)`;

/**
 * Replaces every positively-marked address occurrence in `value` with a
 * minted token, deep-walking arrays, objects, and strings without mutating
 * the input. Two forms are swapped: address substrings in string leaves
 * (LLM-friendly links and standalone schemed entity URIs), and whole
 * single-key `{"@link": "<address>"}` objects, which become the token
 * string. An occurrence the runner cannot parse is left untouched, as is an
 * `@link` whose string is not an entity address (an `opaque:` handle among
 * them) — swapping never throws on weird text.
 */
export const swapLinksForTokens = async (
  table: HarnessHandleTable,
  value: unknown,
  hasher: HandleTokenHasher = sha256Hasher,
): Promise<{ table: HarnessHandleTable; value: unknown }> => {
  if (typeof value === "string") {
    return await swapLinksInString(table, value, hasher);
  }
  if (Array.isArray(value)) {
    const swapped: unknown[] = [];
    for (const item of value) {
      const result = await swapLinksForTokens(table, item, hasher);
      table = result.table;
      swapped.push(result.value);
    }
    return { table, value: swapped };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const target = record["@link"];
    if (keys.length === 1 && typeof target === "string") {
      try {
        const minted = await mintAddressHandle(table, target, hasher);
        return { table: minted.table, value: minted.token };
      } catch {
        // Not an entity address — an `opaque:` handle, or malformed text.
        return { table, value };
      }
    }
    const swapped: Record<string, unknown> = {};
    for (const key of keys) {
      const result = await swapLinksForTokens(table, record[key], hasher);
      table = result.table;
      defineOwnEntry(swapped, key, result.value);
    }
    return { table, value: swapped };
  }
  return { table, value };
};

/**
 * Helper for `swapLinksForTokens()`, which swaps address occurrences within
 * one string leaf. An occurrence whose text matches the grammar but fails
 * the runner's parse is copied through unchanged.
 */
const swapLinksInString = async (
  table: HarnessHandleTable,
  text: string,
  hasher: HandleTokenHasher,
): Promise<{ table: HarnessHandleTable; value: string }> => {
  const pattern = new RegExp(LINK_OCCURRENCE_SOURCE, "g");
  let swapped = "";
  let copiedUpTo = 0;
  for (const match of text.matchAll(pattern)) {
    const occurrence = match[0];
    let token: string;
    try {
      const minted = await mintAddressHandle(
        table,
        occurrence.startsWith("/") ? occurrence : `/${occurrence}`,
        hasher,
      );
      table = minted.table;
      token = minted.token;
    } catch {
      continue;
    }
    swapped += text.slice(copiedUpTo, match.index) + token;
    copiedUpTo = match.index + occurrence.length;
  }
  return { table, value: swapped + text.slice(copiedUpTo) };
};

/**
 * Replaces every known handle token in `value` with its entry's canonical
 * `ref` string, deep-walking arrays, objects, and strings without mutating
 * the input. A well-formed token the table does not hold is left untouched.
 */
export const swapTokensForRefs = (
  table: HarnessHandleTable,
  value: unknown,
): unknown => {
  if (typeof value === "string") {
    return value.replace(
      new RegExp(HANDLE_TOKEN_PATTERN.source, "g"),
      (token) => resolveHandleToken(table, token)?.ref ?? token,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => swapTokensForRefs(table, item));
  }
  if (typeof value === "object" && value !== null) {
    const swapped: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      defineOwnEntry(swapped, key, swapTokensForRefs(table, item));
    }
    return swapped;
  }
  return value;
};

/** Token grammar accepted by {@link assertValidHarnessHandleTable}. */
const FULL_TOKEN_PATTERN = new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`);

/**
 * Asserts that `table` is a well-formed version-1 handle table, guarding the
 * seams that adopt one from persisted state: a version this code does not
 * understand, an empty salt, a malformed entry, or a duplicate token or
 * address is refused with an error naming the problem rather than carried
 * silently into a run.
 *
 * @throws Error naming the first problem found.
 */
export const assertValidHarnessHandleTable = (
  table: HarnessHandleTable,
): void => {
  const raw = table as unknown as Record<string, unknown>;
  if (raw.type !== HARNESS_HANDLE_TABLE_TYPE) {
    throw new Error(
      `invalid handle table: type must be \`${HARNESS_HANDLE_TABLE_TYPE}\`, got \`${
        String(raw.type)
      }\``,
    );
  }
  if (raw.version !== 1) {
    throw new Error(
      `unsupported handle table version: ${String(raw.version)}`,
    );
  }
  if (typeof raw.salt !== "string" || raw.salt.length === 0) {
    throw new Error("invalid handle table: salt must be a non-empty string");
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error("invalid handle table: entries must be an array");
  }
  const tokens = new Set<string>();
  const addressKeys = new Set<string>();
  for (const entry of table.entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("invalid handle table: entry is not an object");
    }
    if (
      typeof entry.token !== "string" || !FULL_TOKEN_PATTERN.test(entry.token)
    ) {
      throw new Error(
        `invalid handle table: malformed token \`${String(entry.token)}\``,
      );
    }
    if (entry.kind !== "address") {
      throw new Error(
        `invalid handle table: entry kind must be \`address\`, got \`${
          String(entry.kind)
        }\``,
      );
    }
    if (typeof entry.ref !== "string" || entry.ref.length === 0) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an empty ref`,
      );
    }
    if (typeof entry.addressKey !== "string" || entry.addressKey.length === 0) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an empty addressKey`,
      );
    }
    if (tokens.has(entry.token)) {
      throw new Error(
        `invalid handle table: duplicate token \`${entry.token}\``,
      );
    }
    tokens.add(entry.token);
    if (addressKeys.has(entry.addressKey)) {
      throw new Error(
        `invalid handle table: duplicate addressKey for token \`${entry.token}\``,
      );
    }
    addressKeys.add(entry.addressKey);
  }
};
