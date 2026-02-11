/**
 * Memory v2 Query Engine
 *
 * Executes simple queries (entity matching, version filtering) and
 * schema-driven graph queries against a v2 space database.
 *
 * @see spec 05-queries.md
 * @module v2-query
 */

import type { EntityId, FactSet, JSONValue } from "./v2-types.ts";
import type { Reference } from "merkle-reference";
import { V2Space } from "./v2-space.ts";

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface QueryOptions {
  branch?: string;
  atVersion?: number;
}

export interface SimpleQuery extends QueryOptions {
  select: Record<string, Record<string, unknown>>;
  since?: number;
}

// ---------------------------------------------------------------------------
// Paginated query types
// ---------------------------------------------------------------------------

export interface PaginatedQuery extends SimpleQuery {
  /** Max number of entities to return. */
  limit: number;
  /** Cursor: entity ID to start after (exclusive). */
  cursor?: EntityId;
}

export interface PaginatedResult {
  facts: FactSet;
  /** Next cursor (entity ID), or undefined if no more results. */
  nextCursor?: EntityId;
  /** Total number of matching entities (if available). */
  total?: number;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const LIST_ALL_HEADS = `
SELECT h.id, h.version, h.fact_hash, f.fact_type, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = ? AND h.type = ?;
`;

const LIST_HEADS_SINCE = `
SELECT h.id, h.version, h.fact_hash, f.fact_type, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = ? AND h.type = ? AND h.version > ?;
`;

const LIST_HEADS_PAGINATED = `
SELECT h.id, h.version, h.fact_hash, f.fact_type, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = ? AND h.type = ? AND h.id > ?
ORDER BY h.id ASC
LIMIT ?;
`;

const LIST_HEADS_SINCE_PAGINATED = `
SELECT h.id, h.version, h.fact_hash, f.fact_type, v.data
FROM head h
JOIN fact f ON f.hash = h.fact_hash
JOIN value v ON v.hash = f.value_ref
WHERE h.branch = ? AND h.type = ? AND h.version > ? AND h.id > ?
ORDER BY h.id ASC
LIMIT ?;
`;

// ---------------------------------------------------------------------------
// Simple query execution
// ---------------------------------------------------------------------------

/**
 * Execute a simple query against a v2 space.
 *
 * Matches entities by id (or wildcard "*"), filters by version range,
 * and supports point-in-time reads via atVersion.
 *
 * @see spec 05-queries.md §5.2
 */
export function executeSimpleQuery(
  space: V2Space,
  query: SimpleQuery,
  type = "application/json",
): FactSet {
  const branch = query.branch ?? "";
  const result: FactSet = {};

  const selectKeys = Object.keys(query.select);
  const isWildcard = selectKeys.includes("*");

  if (isWildcard) {
    // Match all entities on the branch
    const sql = query.since !== undefined ? LIST_HEADS_SINCE : LIST_ALL_HEADS;
    const params = query.since !== undefined
      ? [branch, type, query.since]
      : [branch, type];
    const rows = space.store.prepare(sql).all(...params) as Array<{
      id: string;
      version: number;
      fact_hash: string;
      fact_type: string;
      data: string | null;
    }>;

    for (const row of rows) {
      if (query.atVersion !== undefined) {
        // PIT read
        const value = space.readAtVersion(
          branch,
          row.id as EntityId,
          query.atVersion,
        );
        if (value !== null) {
          result[row.id as EntityId] = {
            value,
            version: query.atVersion,
            hash: row.fact_hash as unknown as Reference,
          };
        }
      } else if (row.fact_type !== "delete") {
        let value: JSONValue | undefined;
        if (row.fact_type === "set") {
          value = row.data !== null ? JSON.parse(row.data) : undefined;
        } else {
          // patch - reconstruct
          value = space.readEntity(branch, row.id as EntityId) ?? undefined;
        }
        result[row.id as EntityId] = {
          value,
          version: row.version,
          hash: row.fact_hash as unknown as Reference,
        };
      }
    }
  }

  // Handle specific entity selectors
  for (const key of selectKeys) {
    if (key === "*") continue;
    const entityId = key as EntityId;

    if (query.atVersion !== undefined) {
      const value = space.readAtVersion(branch, entityId, query.atVersion);
      if (value !== null) {
        const head = space.readHead(branch, entityId);
        result[entityId] = {
          value,
          version: query.atVersion,
          hash: (head?.factHash ?? "") as unknown as Reference,
        };
      }
    } else {
      const head = space.readHead(branch, entityId);
      if (!head) continue;
      if (query.since !== undefined && head.version <= query.since) continue;
      if (head.factType === "delete") continue;

      const value = space.readEntity(branch, entityId);
      result[entityId] = {
        value: value ?? undefined,
        version: head.version,
        hash: head.factHash as unknown as Reference,
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Paginated query execution
// ---------------------------------------------------------------------------

/**
 * Execute a paginated wildcard query.
 * Returns a page of entities with a cursor for the next page.
 *
 * The cursor is entity-ID based (lexicographic ordering on `h.id`),
 * ensuring version-consistent pagination when combined with `since`.
 */
export function executePaginatedQuery(
  space: V2Space,
  query: PaginatedQuery,
  type = "application/json",
): PaginatedResult {
  const branch = query.branch ?? "";
  const cursor = query.cursor ?? "";
  const limit = query.limit + 1; // Fetch one extra to detect next page
  const result: FactSet = {};

  const sql = query.since !== undefined
    ? LIST_HEADS_SINCE_PAGINATED
    : LIST_HEADS_PAGINATED;
  const params = query.since !== undefined
    ? [branch, type, query.since, cursor, limit]
    : [branch, type, cursor, limit];

  const rows = space.store.prepare(sql).all(...params) as Array<{
    id: string;
    version: number;
    fact_hash: string;
    fact_type: string;
    data: string | null;
  }>;

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

  for (const row of pageRows) {
    if (row.fact_type === "delete") continue;

    let value: JSONValue | undefined;
    if (row.fact_type === "set") {
      value = row.data !== null ? JSON.parse(row.data) : undefined;
    } else {
      value = space.readEntity(branch, row.id as EntityId) ?? undefined;
    }

    result[row.id as EntityId] = {
      value,
      version: row.version,
      hash: row.fact_hash as unknown as Reference,
    };
  }

  return {
    facts: result,
    nextCursor: hasMore
      ? (pageRows[pageRows.length - 1].id as EntityId)
      : undefined,
  };
}
