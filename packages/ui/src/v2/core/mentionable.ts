import { type JSONSchema, NAME } from "@commonfabric/runner/shared";

export interface Mentionable {
  [NAME]: string;

  /**
   * The piece a mention of this entry names, held as a cell reference.
   *
   * Optional, and its absence changes what an entry IS. Without one, the
   * entry is the piece itself, listed directly. With one, the entry is a
   * derived row standing for `piece` — the editor lists and matches on the
   * row's own name and resolves `piece` when a completion is picked, so
   * what a mention stores is the piece and never the row.
   *
   * The VALUE at this position never carries a usable handle: an `asCell`
   * position crosses the client boundary as an empty object. A reader
   * detects a row by this key's presence and reaches the piece by ADDRESS
   * — `entry.key("piece").resolveAsCell()` — never through the value.
   */
  piece?: unknown;

  /**
   * The name the collection that owns this member calls it by — `42` for a
   * member of a board that numbers its members.
   *
   * One property for one fact, read at both ends of a mention. On a universe
   * row it is a COPY the collection publishes, so matching a `#42` query
   * costs no read of the member behind it; on a destination piece it is what
   * that piece publishes for itself, which is what lets a mention already in
   * a document gain the name once its member is named.
   *
   * Optional, and absent wherever no collection has named the member, which
   * is what keeps such an entry out of every short-name query rather than
   * matching them all.
   */
  shortName?: string;

  [key: string]: unknown;
}

// A slot may be null: a member whose pattern can't load on this runtime can't
// satisfy MentionableSchema, and the array read degrades it to `null` rather
// than voiding every sibling (see MentionableArraySchema). Consumers skip the
// null holes.
export type MentionableArray = readonly (Mentionable | null)[];

export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    // The `MentionRef.destination` shape: an opaque cell boundary. The value
    // at this position never carries a usable handle — an `asCell` position
    // crosses the client boundary as an empty object — so a reader reaches
    // the piece by ADDRESS and never reads through it under this schema.
    piece: { type: "object", properties: {}, asCell: ["cell"] },
    // One scalar serving both positions this schema is used at: a universe
    // row's copy, and a destination piece's own. Neither read reaches past
    // the string.
    shortName: { type: "string" },
  },
  required: [NAME],
  // While Mentionable may have extra properies on it,
  // we don't need to sync them when using in UI code
  // additionalProperties: true,
} as const satisfies JSONSchema;

export const MentionableArraySchema = {
  type: "array",
  // Per-element degradation, not wholesale void (CT-1863). One space member
  // whose deployed pattern source the current runtime can't load fails
  // MentionableSchema (its NAME never resolves). With a non-nullable element
  // schema the runtime's array traversal voids the ENTIRE read the moment one
  // element fails — so three stranded pieces blanked all 24, emptying the
  // #mention list and any piece view backed by it. Allowing `null` per element
  // makes the existing per-element degradation path fire instead: the bad
  // member becomes a `null` hole and every loadable sibling survives. The
  // `anyOf` order (null first) mirrors the runtime's own nullable-array tests.
  // NOTE: this fixes the mentionable read specifically; hardening the runtime's
  // array traversal to never void wholesale on ANY schema-backed array is a
  // deliberate, broader follow-up (it would change a core read invariant).
  items: {
    anyOf: [
      { type: "null" },
      MentionableSchema,
    ],
  },
} as const satisfies JSONSchema;
