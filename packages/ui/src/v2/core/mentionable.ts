import { NAME } from "@commonfabric/runner/shared";

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

export type MentionableArray = readonly Mentionable[];

export {
  MentionableArraySchema,
  MentionableSchema,
} from "@commonfabric/runner/component-read-contract";
