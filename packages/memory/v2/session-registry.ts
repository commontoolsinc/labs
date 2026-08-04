import type { SessionDescriptor, SessionToken, WatchSpec } from "../v2.ts";
import type { TrackedGraphState } from "./query.ts";
import type { SessionCacheEntry } from "./server-sync.ts";
import { trackedIdsFromEntries } from "./server-sync.ts";

export type SessionState = {
  id: string;
  space: string;
  sessionToken: SessionToken;
  seenSeq: number;
  lastSyncedSeq: number;
  watches: WatchSpec[];
  graphs: Map<string, TrackedGraphState>;
  entities: Map<string, SessionCacheEntry>;
  trackedIds: Set<string>;
  caughtUpLocalSeq: number;
  pendingCaughtUpLocalSeq: number;
  /** Set when delivery-state rollback re-inserted tombstone cache entries
   * for a lost frame's removes: the incremental refresh path never emits
   * removes, so the next sync must run a FULL watch evaluation to re-diff
   * them out (CT-1927 review, round 7). Self-clearing. */
  forceFullResync: boolean;
  expiresAt: number | null;
  ownerConnectionId: string | null;
  principal?: string;
};

type OpenSessionState = {
  sessionId: string;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  revokedConnectionId?: string;
};

const sessionKey = (space: string, sessionId: string): string =>
  `${space}\0${sessionId}`;

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const nextSessionToken = (): SessionToken =>
  crypto.randomUUID() as SessionToken;

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  #prune(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
  }

  open(
    space: string,
    session: SessionDescriptor,
    serverSeq: number,
    ownerConnectionId = "session-registry",
    principal?: string,
  ): OpenSessionState {
    this.#prune();
    const sessionId = session.sessionId ?? crypto.randomUUID();
    const key = sessionKey(space, sessionId);
    let existing = this.#sessions.get(key);
    if (
      existing?.principal !== undefined &&
      principal !== existing.principal
    ) {
      throw authorizationError(
        `session ${sessionId} is already bound to ${existing.principal}`,
      );
    }
    let displacedConnectionId: string | undefined;
    if (
      existing !== undefined &&
      session.sessionToken !== existing.sessionToken
    ) {
      displacedConnectionId = existing.ownerConnectionId ?? undefined;
      // A stale resume token is most often the artifact of a LOST
      // session.open response: the registry rotated the token, the client
      // never received it, and its retry presents the previous one.
      // Treating that as a terminal revocation strands the client (the
      // memory client closes the session for good). Treat it as a FRESH
      // session under the same id instead: same principal (checked above),
      // none of the old session's state, `resumed` absent — so the client
      // runs its replacement path (watch reinstall, marker-epoch reset,
      // parked-accept reconciliation). A racing old connection still gets
      // revoked through `revokedConnectionId` below (CT-1927 review,
      // round 7).
      existing = undefined;
    }
    const seenSeq = Math.max(
      existing?.seenSeq ?? 0,
      session.seenSeq ?? 0,
    );
    const sessionToken = nextSessionToken();
    const currentHolderConnectionId = existing?.ownerConnectionId ??
      displacedConnectionId ?? null;
    const revokedConnectionId = currentHolderConnectionId !== null &&
        currentHolderConnectionId !== ownerConnectionId
      ? currentHolderConnectionId
      : undefined;
    this.#sessions.set(key, {
      id: sessionId,
      space,
      sessionToken,
      seenSeq,
      lastSyncedSeq: existing?.lastSyncedSeq ?? seenSeq,
      watches: existing?.watches ?? [],
      graphs: existing?.graphs ?? new Map(),
      entities: existing?.entities ?? new Map(),
      trackedIds: existing?.trackedIds ??
        trackedIdsFromEntries(existing?.entities?.values() ?? []),
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      pendingCaughtUpLocalSeq: existing?.pendingCaughtUpLocalSeq ?? 0,
      forceFullResync: existing?.forceFullResync ?? false,
      expiresAt: null,
      ownerConnectionId,
      principal: existing?.principal ?? principal,
    });
    return {
      sessionId,
      sessionToken,
      serverSeq,
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      ...(existing !== undefined ? { resumed: true } : {}),
      ...(revokedConnectionId ? { revokedConnectionId } : {}),
    };
  }

  get(space: string, sessionId: string): SessionState | null {
    this.#prune();
    return this.#sessions.get(sessionKey(space, sessionId)) ?? null;
  }

  hasOpenSessionForPrincipal(
    space: string,
    principal: string | undefined,
  ): boolean {
    this.#prune();
    for (const session of this.#sessions.values()) {
      if (
        session.space === space &&
        session.principal === principal
      ) {
        return true;
      }
    }
    return false;
  }

  sessionsForSpace(space: string): SessionState[] {
    this.#prune();
    const sessions: SessionState[] = [];
    for (const session of this.#sessions.values()) {
      if (session.space === space) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /** Remove a session outright (e.g. its principal lost access). */
  remove(space: string, sessionId: string): void {
    this.#sessions.delete(sessionKey(space, sessionId));
  }

  updateSeenSeq(
    space: string,
    sessionId: string,
    seenSeq: number,
  ): SessionState | null {
    const session = this.get(space, sessionId);
    if (session === null) {
      return null;
    }
    session.seenSeq = Math.max(session.seenSeq, seenSeq);
    return session;
  }

  detach(space: string, sessionId: string, ownerConnectionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session?.ownerConnectionId === ownerConnectionId) {
      session.ownerConnectionId = null;
      session.expiresAt = Date.now() + this.#ttlMs;
    }
  }
}
