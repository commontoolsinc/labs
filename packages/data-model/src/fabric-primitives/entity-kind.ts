import { FabricHash } from "./FabricHash.ts";

/**
 * Entity kinds version a `FabricHash`'s format tag: `fid2:computed:<hash>`
 * names an entity whose contents are a pure function of its pattern's
 * inputs, re-derivable by any runtime holding the same inputs. The kind
 * participates in identity — it is minted into the hash preimage AND the
 * visible tag from the same argument (`createRef`'s `kind` option), so the
 * two representations cannot diverge and a kind change necessarily names a
 * different entity.
 *
 * `fid1:<hash>` remains the untagged form with strict, authoritative
 * semantics. `fid2` is a FORMAT version, not a new hash algorithm: the bytes
 * are produced by the same fid1 hashing, and the version bump exists so the
 * first segment stays a pure format discriminator — a parser that only knows
 * fid1 fails loudly on a kinded id instead of silently mis-handling it.
 * `FabricHash.fromString` splits at the last colon (the hash segment is
 * base64url and never contains one), so the parsed `tag` of a kinded id is
 * `"fid2:<kind>"`.
 *
 * See `docs/specs/computed-cell-identity.md`.
 */
export type EntityKind = "computed";

/** The format tag prefix of kind-tagged entity ids (`fid2:<kind>:<hash>`). */
export const KINDED_ID_TAG_PREFIX = "fid2:";

/** The format tag of untagged entity ids, which kinded minting upgrades. */
const UNKINDED_ID_TAG = "fid1";

const KNOWN_ENTITY_KINDS: ReadonlySet<string> = new Set(["computed"]);

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && KNOWN_ENTITY_KINDS.has(value);
}

/**
 * Returns a `FabricHash` with the same bytes whose format tag carries `kind`
 * (`fid1` → `fid2:<kind>`). Throws on any other input tag: kinds are minted
 * exactly once, at id creation, and only on top of the fid1 format.
 */
export function withEntityKind(hash: FabricHash, kind: EntityKind): FabricHash {
  if (hash.tag !== UNKINDED_ID_TAG) {
    throw new Error(
      `Cannot mint a kind onto tag "${hash.tag}"; kinds are minted once, ` +
        `onto ${UNKINDED_ID_TAG} hashes only`,
    );
  }
  return new FabricHash(
    hash.bytes,
    `${KINDED_ID_TAG_PREFIX}${kind}`,
  );
}

/**
 * Parses the kind from a format tag (e.g. `"fid2:computed"` → `"computed"`).
 * Unknown kind suffixes return `undefined` — callers must treat unrecognized
 * kinds as strict/authoritative, never relaxed.
 */
export function entityKindOfTag(tag: string): EntityKind | undefined {
  if (!tag.startsWith(KINDED_ID_TAG_PREFIX)) return undefined;
  const kind = tag.slice(KINDED_ID_TAG_PREFIX.length);
  return isEntityKind(kind) ? kind : undefined;
}

/**
 * Parses the kind from an id string in tagged-hash form
 * (`fid2:computed:<hash>`) or `of:`-prefixed URI form. Non-entity URIs
 * (e.g. `data:`) and untagged ids return `undefined`.
 */
export function entityKindOfIdString(id: string): EntityKind | undefined {
  const start = id.startsWith("of:") ? 3 : 0;
  const lastColon = id.lastIndexOf(":");
  if (lastColon <= start) return undefined;
  return entityKindOfTag(id.slice(start, lastColon));
}

let computedCellIdsEnabled = false;

/**
 * Ambient runtime flag gating the MINTING of kind-tagged computed-cell ids.
 * Readers accept both forms unconditionally regardless of this flag — new-form
 * ids are a data-compatibility event, so only creation is gated.
 */
export function setComputedCellIdsConfig(enabled?: boolean): void {
  computedCellIdsEnabled = enabled ?? false;
}

export function getComputedCellIdsConfig(): boolean {
  return computedCellIdsEnabled;
}

export function resetComputedCellIdsConfig(): void {
  computedCellIdsEnabled = false;
}
