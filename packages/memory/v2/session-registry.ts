import type {
  SessionDescriptor,
  SessionOpenResult,
  SessionToken,
  WatchSpec,
} from "../v2.ts";
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
  expiresAt: number | null;
  ownerConnectionId: string | null;
  principal?: string;
};

type OpenSessionState = SessionOpenResult & {
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
      expiresAt: null,
      ownerConnectionId,
      principal: existing?.principal ?? principal,
    });
    return {
      sessionId,
      sessionToken,
      serverSeq,
      ...(existing !== undefined ? { resumed: true } : {}),
      ...(revokedConnectionId ? { revokedConnectionId } : {}),
    };
  }

  get(space: string, sessionId: string): SessionState | null {
    this.#prune();
    return this.#sessions.get(sessionKey(space, sessionId)) ?? null;
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
