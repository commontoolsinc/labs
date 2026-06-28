// Scope awareness — the per-identity dimension the runtime composes and this
// tool (until now) ignored.
//
// `revision.scope_key` partitions an entity's rows into scopes that OVERLAP by
// id:
//   space                              shared / default      (PerSpace cells)
//   user:did:key:<DID>                 per-user state        (PerUser cells)
//   session:did:key:<DID>:<uuid>       per-session state     (PerSession cells)
//
// The same cell id can hold a `space` value AND a per-user override, and they
// differ (verified: `space` a link/default; `user` the concrete per-user state,
// e.g. a per-user VDOM). The runtime resolves what an identity sees as
// MOST-SPECIFIC-WINS: session:X:sid ⊕ user:X ⊕ space. "View as identity X"
// overlays X's scopes on top of the shared space — surfacing exactly the
// per-user divergence ("looks different for me") that multiplayer bugs live in.

import type { SpaceDb } from "./db.ts";
import { annotate, summarize } from "./decode.ts";
import { reconstructDocument } from "./reconstruct.ts";

export type ScopeKind = "space" | "user" | "session" | "other";

export interface Scope {
  /** The raw scope_key as stored (often %-encoded). */
  raw: string;
  kind: ScopeKind;
  /** Owning principal DID (user/session scopes). */
  principal?: string;
  /** Session uuid (session scopes). */
  sessionId?: string;
  entities: number;
  revisions: number;
}

/** Parse a stored scope_key into its kind + principal/session. */
export function parseScope(raw: string): Scope {
  const decoded = decodeURIComponent(raw);
  if (decoded === "space") {
    return { raw, kind: "space", entities: 0, revisions: 0 };
  }
  let m = decoded.match(/^session:(did:key:[^:]+):(.+)$/);
  if (m) {
    return {
      raw,
      kind: "session",
      principal: m[1],
      sessionId: m[2],
      entities: 0,
      revisions: 0,
    };
  }
  m = decoded.match(/^user:(did:key:[^:]+)$/);
  if (m) {
    return { raw, kind: "user", principal: m[1], entities: 0, revisions: 0 };
  }
  return { raw, kind: "other", entities: 0, revisions: 0 };
}

const KIND_ORDER: Record<ScopeKind, number> = {
  space: 0,
  user: 1,
  session: 2,
  other: 3,
};

/** Enumerate the scopes present in a space, with entity/revision counts. */
export function listScopes(
  space: SpaceDb,
  opts: { branch?: string } = {},
): Scope[] {
  const branch = opts.branch ?? "";
  const rows = space.db
    .prepare(
      `SELECT scope_key, count(DISTINCT id) ents, count(*) revs
       FROM revision WHERE branch = ? GROUP BY scope_key`,
    )
    .all<{ scope_key: string; ents: number; revs: number }>(branch);
  return rows
    .map((r) => ({
      ...parseScope(r.scope_key),
      entities: r.ents,
      revisions: r.revs,
    }))
    .sort((a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.revisions - a.revisions
    );
}

/**
 * The scope precedence chain for an identity — most specific first. With a
 * sessionId: `[session:X:sid, user:X, space]`; without: `[user:X, space]`.
 */
export function resolveScopeChain(
  identity: string,
  sessionId?: string,
): string[] {
  const chain: string[] = [];
  if (sessionId) chain.push(`session:${identity}:${sessionId}`);
  chain.push(`user:${identity}`);
  chain.push("space");
  return chain;
}

export interface IdentityValue {
  exists: boolean;
  /** The scope the value resolved from (the most specific that had the id). */
  resolvedScope?: string;
  resolvedKind?: ScopeKind;
  value?: unknown;
  /** True if a more-general scope ALSO holds this id (i.e. this is an override). */
  overrides?: boolean;
}

/** Does this scope hold any row for `id`? (raw scope_key match.) */
function scopeHasEntity(
  space: SpaceDb,
  id: string,
  scope: string,
  branch: string,
): boolean {
  const row = space.db
    .prepare(
      `SELECT 1 AS one FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? LIMIT 1`,
    )
    .get<{ one: number }>(branch, id, scope);
  return !!row;
}

/**
 * Read an entity's value AS an identity sees it — walking the precedence chain
 * (session ⊕ user ⊕ space) and returning the value from the most specific scope
 * that holds the id, plus whether a more-general scope also holds it (override).
 */
export function valueAsIdentity(
  space: SpaceDb,
  opts: {
    id: string;
    identity: string;
    sessionId?: string;
    branch?: string;
    atSeq?: number;
  },
): IdentityValue {
  const branch = opts.branch ?? "";
  const chain = resolveScopeChain(opts.identity, opts.sessionId)
    // The raw stored scope_key is %-encoded for user/session; match that form.
    .map((s) => (s === "space" ? s : encodeScope(s)));
  for (let i = 0; i < chain.length; i++) {
    const scope = chain[i];
    if (!scopeHasEntity(space, opts.id, scope, branch)) continue;
    const doc = reconstructDocument(space, {
      id: opts.id,
      scope,
      branch,
      atSeq: opts.atSeq,
    });
    const overrides = chain
      .slice(i + 1)
      .some((s) => scopeHasEntity(space, opts.id, s, branch));
    return {
      exists: doc !== undefined,
      resolvedScope: scope,
      resolvedKind: parseScope(scope).kind,
      value: doc === undefined ? undefined : annotate(doc.value),
      overrides,
    };
  }
  return { exists: false };
}

/** Stored scope_keys %-encode the `did:key:` colons; match that on the way in. */
function encodeScope(scope: string): string {
  // session:did:key:<DID>:<uuid>  /  user:did:key:<DID>
  return scope.replace(/did:key:/g, "did%3Akey%3A");
}

export interface ScopeVariant {
  scope: string;
  kind: ScopeKind;
  principal?: string;
  sessionId?: string;
  value: unknown;
  summary: string;
  revisions: number;
}

export interface ScopeOverlay {
  id: string;
  variants: ScopeVariant[];
  /** True when the id appears in >1 scope (a per-identity override exists). */
  overridden: boolean;
  /** True when those scopes hold DIFFERENT values (real divergence). */
  divergent: boolean;
}

/**
 * Every scope an entity appears in, with its value there — the per-user/session
 * divergence table for one id. The multiplayer "who sees what" view.
 */
export function scopeOverlay(
  space: SpaceDb,
  id: string,
  opts: { branch?: string } = {},
): ScopeOverlay {
  const branch = opts.branch ?? "";
  const rows = space.db
    .prepare(
      `SELECT scope_key, count(*) revs FROM revision
       WHERE branch = ? AND id = ? GROUP BY scope_key`,
    )
    .all<{ scope_key: string; revs: number }>(branch, id);
  const variants: ScopeVariant[] = rows.map((r) => {
    const doc = reconstructDocument(space, { id, scope: r.scope_key, branch });
    const s = parseScope(r.scope_key);
    return {
      scope: r.scope_key,
      kind: s.kind,
      principal: s.principal,
      sessionId: s.sessionId,
      value: doc === undefined ? undefined : annotate(doc.value),
      summary: doc === undefined ? "(absent)" : summarize(doc.value),
      revisions: r.revs,
    };
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const keys = new Set(variants.map((v) => JSON.stringify(v.value)));
  return {
    id,
    variants,
    overridden: variants.length > 1,
    divergent: keys.size > 1,
  };
}
