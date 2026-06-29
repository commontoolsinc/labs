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
// e.g. a per-user VDOM).
//
// IMPORTANT — what the runtime actually does vs. what this view approximates.
// The runtime reads ONE declared scope_key at a time (via the engine's
// `resolveScopeKey`), and a narrowed write stores a LINK at the base-scope slot
// pointing at the narrow instance; readers reach the narrow value by FOLLOWING
// that link (see `packages/runner/src/data-updating.ts` / `scope.ts`). There is
// no read-time "fall back from session→user→space". So `valueAsIdentity` below
// is an APPROXIMATION — "the most-specific scope that holds this id" — not the
// runtime's resolution. {@link scopeOverlay} (every scope side-by-side) is the
// honest, runtime-true divergence view; prefer it. Scope-key construction reuses
// the engine's exported `resolveScopeKey` so encoding never drifts.

import type { SpaceDb } from "./db.ts";
import { resolveScopeKey } from "@commonfabric/memory/v2/engine";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
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
  // The platform `DID` type is `did:<method>:<id>` — not only `did:key:`. Match
  // any method so a `did:web:` / `did:plc:` writer is still attributed to a
  // principal (else it falls through to `other` and is miscounted as no-user).
  let m = decoded.match(/^session:(did:[a-z0-9]+:[^:]+):(.+)$/);
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
  m = decoded.match(/^user:(did:[a-z0-9]+:[^:]+)$/);
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
 * The most-specific-first chain of stored scope_keys for an identity. With a
 * sessionId: `[session:X:sid, user:X, space]`; without: `[user:X, space]`.
 * Encoding goes through the engine's `resolveScopeKey`, so the keys are exactly
 * what the runtime writes (no hand-rolled %-encoding to drift).
 */
export function resolveScopeChain(
  identity: string,
  sessionId?: string,
): string[] {
  const chain: string[] = [];
  if (sessionId) {
    chain.push(
      resolveScopeKey("session", { principal: identity, sessionId }),
    );
  }
  chain.push(resolveScopeKey("user", { principal: identity }));
  chain.push(resolveScopeKey("space", {}));
  return chain;
}

export interface IdentityValue {
  exists: boolean;
  /** The scope the value resolved from (the most specific that held the id). */
  resolvedScope?: string;
  resolvedKind?: ScopeKind;
  value?: unknown;
  /** True if a more-general scope ALSO holds this id (i.e. this is an override). */
  overrides?: boolean;
  /** Honest reminder this is an approximation, not the runtime read path. */
  approximation: true;
}

/**
 * Does this scope hold a row for `id` visible at `atSeq`? Bounded by `atSeq`, so
 * a scope whose only row is in the FUTURE (after atSeq) is not treated as
 * present — otherwise a time-travel read picks a future override and reports the
 * entity absent instead of falling through to the value visible at that seq.
 */
function scopeHasEntity(
  space: SpaceDb,
  id: string,
  scope: string,
  branch: string,
  atSeq?: number,
): boolean {
  const row = space.db
    .prepare(
      `SELECT 1 AS one FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ? LIMIT 1`,
    )
    .get<{ one: number }>(branch, id, scope, atSeq ?? Number.MAX_SAFE_INTEGER);
  return !!row;
}

/**
 * APPROXIMATE an identity's view of an entity by returning the value from the
 * most-specific scope that holds the id (session ⊕ user ⊕ space). This is NOT
 * the runtime's read resolution (see the file header) — it cannot, from an id
 * alone, know which declared scope a real read would target, nor follow the
 * base-scope link the runtime uses. Use {@link scopeOverlay} for the ground
 * truth. The `approximation` flag is here so callers can't forget that.
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
  const chain = resolveScopeChain(opts.identity, opts.sessionId);
  for (let i = 0; i < chain.length; i++) {
    const scope = chain[i];
    if (!scopeHasEntity(space, opts.id, scope, branch, opts.atSeq)) continue;
    const doc = reconstructDocument(space, {
      id: opts.id,
      scope,
      branch,
      atSeq: opts.atSeq,
    });
    const overrides = chain
      .slice(i + 1)
      .some((s) => scopeHasEntity(space, opts.id, s, branch, opts.atSeq));
    return {
      exists: doc !== undefined,
      resolvedScope: scope,
      resolvedKind: parseScope(scope).kind,
      value: doc === undefined ? undefined : annotate(doc.value),
      overrides,
      approximation: true,
    };
  }
  return { exists: false, approximation: true };
}

export interface Participant {
  /** The identity (user) DID. */
  did: string;
  /** True when this DID owns the space (space DID == did → it's their home). */
  isOwner: boolean;
  /** Commits whose session principal is this DID. */
  commits: number;
  /** Distinct sessions (browser tabs/devices) this DID acted from. */
  sessions: number;
  /** Entities this DID has in a `user:<DID>` scope here. */
  userEntities: number;
  /** Entities this DID has in `session:<DID>:*` scopes here. */
  sessionEntities: number;
}

/**
 * The identities (users) that touched a space: everyone who committed (by
 * session principal) plus everyone with per-user/session scoped state. The
 * "who is in this space" view — each `did` is browsable via
 * {@link describeIdentity} (its home + profiles across the discovered DBs).
 */
export function spaceParticipants(
  space: SpaceDb,
  opts: { branch?: string } = {},
): Participant[] {
  const ownDid = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");
  const acc = new Map<string, Participant>();
  const get = (did: string): Participant => {
    let p = acc.get(did);
    if (!p) {
      p = {
        did,
        isOwner: did === ownDid,
        commits: 0,
        sessions: 0,
        userEntities: 0,
        sessionEntities: 0,
      };
      acc.set(did, p);
    }
    return p;
  };

  // commits + distinct sessions by principal — branch-filtered to match the
  // scoped-entity counts below (which come from listScopes, also branch-scoped).
  const branch = opts.branch ?? "";
  for (
    const r of space.db
      .prepare(
        `SELECT session_id, count(*) n FROM "commit"
         WHERE branch = ? GROUP BY session_id`,
      )
      .all<{ session_id: string; n: number }>(branch)
  ) {
    // A commit `session_id` has the same shape as a session scope_key.
    const did = r.session_id ? parseScope(r.session_id).principal : undefined;
    if (!did) continue;
    const p = get(did);
    p.commits += r.n;
    p.sessions += 1;
  }

  // per-user / per-session scoped entities by principal
  for (const sc of listScopes(space, opts)) {
    if (sc.kind === "user" && sc.principal) {
      get(sc.principal).userEntities += sc.entities;
    } else if (sc.kind === "session" && sc.principal) {
      get(sc.principal).sessionEntities += sc.entities;
    }
  }

  return [...acc.values()].sort((a, b) =>
    (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || b.commits - a.commits
  );
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

  // Content-key each variant with the data-model's canonical hash (not
  // key-order-sensitive JSON.stringify, which both mis-flags same-value/
  // different-key-order as divergent and throws on BigInt/Fabric leaves).
  const keys = new Set(variants.map((v) => hashStringOf(v.value)));
  return {
    id,
    variants,
    overridden: variants.length > 1,
    divergent: keys.size > 1,
  };
}
