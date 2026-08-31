import { type JSONSchema, NAME } from "@commonfabric/runner/shared";

export interface Mentionable {
  [NAME]: string;

  /**
   * The piece a mention of this entry names, held as a cell reference.
   *
   * Optional, and its absence changes what an entry IS. Without one, the
   * entry is the piece itself, listed directly. With one, the entry is a
   * derived row standing for `piece` — the editor lists and matches on the
   * row's own strings and resolves `piece` when a completion is picked, so
   * what a mention stores is the piece and never the row.
   */
  piece?: unknown;
  [key: string]: unknown;
}

export type MentionableArray = readonly Mentionable[];

export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    // The `MentionRef.destination` shape: an opaque cell boundary, hydrated
    // to a handle and never read through under this schema.
    piece: { type: "object", properties: {}, asCell: ["cell"] },
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
