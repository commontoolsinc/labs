/**
 * Space entry schemas for home space data.
 * These define the structure of user's managed spaces list.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const spaceEntrySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    did: { type: "string" },
  },
  required: ["name"],
} as const satisfies JSONSchema;

export type SpaceEntry = Schema<typeof spaceEntrySchema>;

export const spacesListSchema = {
  type: "array",
  items: spaceEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type SpacesList = Schema<typeof spacesListSchema>;

/**
 * Site table: where each space lives. The home space carries a per-user
 * table of `did → host` facts — the v0 of hint-driven space resolution
 * (2026-06-09 federation session: "the smallest possible slice"). The
 * runtime reads it as its live host lookup; writers include the local
 * daemon (syncing its served sources) and link-receipt flows.
 *
 * Entries are HINTS: unverified in v0 (the space's own log is the
 * integrity boundary, not the host), and a hint must never silently
 * re-point a space the runtime already opened.
 *
 * SECURITY (v0, explicit): the table is ordinary home-space data, so
 * ANYTHING with home-space write access — including patterns running
 * there — can steer where a not-yet-opened space is fetched from.
 * That is a deliberate v0 trade (matching "don't even verify in the
 * first month") and the forcing function for audience-binding the
 * session handshake before host hints ever come from less-trusted
 * data.
 *
 * Table semantics: an array with no uniqueness constraint — for an
 * unopened space, the LAST entry for a did wins; REMOVING an entry
 * does not unregister an already-learned hint until the runtime
 * restarts.
 */
export const spaceHostEntrySchema = {
  type: "object",
  properties: {
    /** The space DID this fact is about — the table key. */
    did: { type: "string" },
    /** Base URL of the host currently serving the space. */
    host: { type: "string" },
    /** ISO timestamp of when this fact was recorded. */
    updatedAt: { type: "string" },
    /** Who recorded it (e.g. "local-source-sync", "share-link"). */
    source: { type: "string" },
  },
  required: ["did", "host"],
} as const satisfies JSONSchema;

export type SpaceHostEntry = Schema<typeof spaceHostEntrySchema>;

export const siteTableSchema = {
  type: "array",
  items: spaceHostEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type SiteTable = Schema<typeof siteTableSchema>;

/**
 * Canonical cause for the home-space site-table cell, shared by the
 * runtime (reader) and embedder daemons (writers) so both address the
 * same document: `getCell(userDid, siteTableCause(userDid), siteTableSchema)`.
 */
export function siteTableCause(userDid: string): { siteTable: string } {
  return { siteTable: userDid };
}
