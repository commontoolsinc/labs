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

const revokedError = (message: string): Error =>
  Object.assign(new Error(message), { name: "SessionRevokedError" });

const nextSessionToken = (): SessionToken =>
  crypto.randomUUID() as SessionToken;

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();
  #removalObservers: Array<(session: SessionState) => void> = [];

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  /** Registers an observer fired after a session leaves the registry —
   * TTL expiry and outright removal alike — so owners of per-session
   * state keyed outside the registry (e.g. the engine's CT-1910 inference
   * retention) can release it. A registration method rather than a
   * constructor option so a Server can attach cleanup to an INJECTED
   * registry too. Never fires for a resume: `open` replaces the entry in
   * place. */
  onSessionRemoved(observer: (session: SessionState) => void): void {
    this.#removalObservers.push(observer);
  }

  #notifyRemoved(session: SessionState): void {
    for (const observer of this.#removalObservers) {
      observer(session);
    }
  }

  #prune(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(key);
        this.#notifyRemoved(session);
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
    const existing = this.#sessions.get(key);
    if (
      existing?.principal !== undefined &&
      principal !== existing.principal
    ) {
      throw authorizationError(
        `session ${sessionId} is already bound to ${existing.principal}`,
      );
    }
    if (
      existing !== undefined &&
      session.sessionToken !== existing.sessionToken
    ) {
      throw revokedError(
        `session ${sessionId} resume token is no longer valid`,
      );
    }
    const seenSeq = Math.max(
      existing?.seenSeq ?? 0,
      session.seenSeq ?? 0,
    );
    const sessionToken = nextSessionToken();
    const revokedConnectionId = existing?.ownerConnectionId !== undefined &&
        existing.ownerConnectionId !== null &&
        existing.ownerConnectionId !== ownerConnectionId
      ? existing.ownerConnectionId
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
    const key = sessionKey(space, sessionId);
    const session = this.#sessions.get(key);
    this.#sessions.delete(key);
    if (session !== undefined) {
      this.#notifyRemoved(session);
    }
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
