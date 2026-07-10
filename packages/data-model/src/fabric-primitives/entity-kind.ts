/**
 * Entity kinds version an entity id's URI SCHEME: `computed:fid1:<hash>`
 * names an entity whose contents are re-derivable by the runtime that
 * minted it. The kind's ONLY representation is the URI scheme: the hash
 * preimage is kind-free (see `createRef`), so a computed cell and a state
 * cell minted from the same cause share hash bytes and differ solely in
 * scheme — which is why the full URI string, scheme included, is the
 * identity, and a kind change still names a different entity.
 *
 * `of:fid1:<hash>` remains the unkinded form with strict, authoritative
 * semantics. The kind rides the scheme, NOT the `FabricHash` format tag: the
 * tag stays `fid1` (same bytes, same hashing) and `FabricHash.fromString`
 * is unaffected. Because the scheme is part of the URI string, the URI
 * string IS the identity — never rebuild a computed cell's URI from its
 * bare hash.
 *
 * See `docs/specs/computed-cell-identity.md`.
 */
export type EntityKind = "computed";

/** The URI scheme of computed-kind entity ids (`computed:fid1:<hash>`). */
export const COMPUTED_URI_SCHEME = "computed";

const KNOWN_ENTITY_KINDS: ReadonlySet<string> = new Set(["computed"]);

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && KNOWN_ENTITY_KINDS.has(value);
}

/**
 * The URI scheme that carries `kind`: `undefined` (no kind) maps to the
 * plain `"of"` scheme, `"computed"` to {@link COMPUTED_URI_SCHEME}.
 */
export function uriSchemeForEntityKind(
  kind: EntityKind | undefined,
): "of" | typeof COMPUTED_URI_SCHEME {
  return kind === undefined ? "of" : COMPUTED_URI_SCHEME;
}

/**
 * Parses the kind from an id string's URI scheme (the segment before the
 * FIRST colon): `computed:fid1:<hash>` → `"computed"`. Every other form —
 * `of:` URIs, bare tagged hashes (`fid1:<hash>`), non-entity URIs (e.g.
 * `data:`), colon-free strings, and UNKNOWN schemes (e.g. `future:fid1:…`)
 * — returns `undefined`, which callers must treat as strict/authoritative,
 * never relaxed.
 */
export function entityKindOfIdString(id: string): EntityKind | undefined {
  const colon = id.indexOf(":");
  if (colon === -1) return undefined;
  const scheme = id.slice(0, colon);
  return scheme === COMPUTED_URI_SCHEME ? "computed" : undefined;
}

let computedCellIdsEnabled = false;

/**
 * Ambient runtime flag gating the MINTING of kind-schemed computed-cell ids.
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
