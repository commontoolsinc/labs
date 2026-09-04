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
   * The name the collection publishing this row calls the member by — `42`
   * for a member of a board that numbers its members.
   *
   * A COPY carried on the row, so that matching a `#42` query costs no read
   * of the member behind it. Optional, and absent on every row of a universe
   * whose collection names nothing, which is what keeps such a row out of
   * every short-name query rather than matching them all.
   */
  name?: string;

  /**
   * The name the piece at this position publishes for ITSELF, read live
   * rather than copied, which is what lets a mention already in a document
   * gain the name once its destination starts publishing one.
   *
   * `name` above is a collection's copy of the same fact, and the two are
   * read by different surfaces: the completion lists rows and never opens
   * the pieces behind them, while a pill holds a subscription to the one
   * piece it names.
   */
  shortName?: string;

  [key: string]: unknown;
}

export type MentionableArray = readonly Mentionable[];

export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    // The `MentionRef.destination` shape: an opaque cell boundary. The value
    // at this position never carries a usable handle — an `asCell` position
    // crosses the client boundary as an empty object — so a reader reaches
    // the piece by ADDRESS and never reads through it under this schema.
    piece: { type: "object", properties: {}, asCell: ["cell"] },
    // Two scalars, so this schema serves both of the positions it is used at:
    // a universe row carries `name` and a destination piece publishes
    // `shortName`, and neither read reaches past the string.
    name: { type: "string" },
    shortName: { type: "string" },
  },
  required: [NAME],
  // While Mentionable may have extra properies on it,
  // we don't need to sync them when using in UI code
  // additionalProperties: true,
} as const satisfies JSONSchema;

export const MentionableArraySchema = {
  type: "array",
  items: MentionableSchema,
} as const satisfies JSONSchema;
