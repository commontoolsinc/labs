/**
 * The embedded schemas: well-known schema bodies resolvable by URL from a
 * static in-process table on every peer, with no document behind them. The
 * renderer's vdom/vnode schemas are the residents.
 *
 * Transitional (`docs/specs/content-addressed-schemas.md`): an embedded ref
 * is an allowed leaf inside content-addressed schema documents — every
 * realm resolves it identically without any closure entry — and the
 * expectation is that these refs retire in favor of ordinary `cid:`
 * documents, at which point this table goes with them. Stored documents
 * carrying the URLs keep resolving until then.
 */

import type { JSONSchema } from "@commonfabric/api";
import { rendererVDOMSchema, vnodeSchema } from "./schemas.ts";

export const embeddedSchemas: Record<string, JSONSchema> = {
  "https://commonfabric.org/schemas/vdom.json": rendererVDOMSchema,
  "https://commonfabric.org/schemas/vnode.json": vnodeSchema,
};

/** Whether `schemaRef` names an embedded schema. */
export const isEmbeddedCfcSchemaRef = (schemaRef: string): boolean =>
  Object.hasOwn(embeddedSchemas, schemaRef);
