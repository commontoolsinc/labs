import {
  actionClaimMapKey,
  executionClaimIncarnationKey,
  ExecutionControlEvent,
  type ExecutionSettlementFrontier,
  SessionDescriptor,
  SessionToken,
  WatchSpec,
} from "../v2.ts";
import type { TrackedGraphState } from "./query.ts";
import type { DocSetMember, SessionCacheEntry } from "./server-sync.ts";
import { trackedIdsFromEntries } from "./server-sync.ts";

export type SessionState = {
  id: string;
  space: string;
  sessionToken: SessionToken;
  seenSeq: number;
  lastSyncedSeq: number;
  watches: WatchSpec[];
  /** C1.4b: acting principal the current watch set was registered under
   * (a lease-bound executor session acting for a lane); undefined = the
   * session's own scope context. Replaced atomically with the watch set. */
  watchScopePrincipal?: string;
  graphs: Map<string, TrackedGraphState>;
  entities: Map<string, SessionCacheEntry>;
  /** F3 doc-set membership, keyed by resolved scope key (docSetMemberKey).
   * Distinct from `entities` (graph-tracked): the per-wave fan-out point-reads
   * these members and `trackedIds` is the UNION of both surfaces (FA14). */
  docSetMembers: Map<string, DocSetMember>;
  /** FB15/FA1: member keys whose point read was skipped by the stale-binding
   * fail-open. The wave that skipped them still advanced the watermark, so
   * they are re-staged dirty on the NEXT wave (and cleared once a read
   * completes) — otherwise the skipped delta would be silently lost until an
   * unrelated write to the same doc or a resume. */
  docSetMemberRetryKeys: Set<string>;
  trackedIds: Set<string>;
  caughtUpLocalSeq: number;
  pendingCaughtUpLocalSeq: number;
  expiresAt: number | null;
  ownerConnectionId: string | null;
  principal?: string;
  /** Capability negotiated by the connection currently owning this session. */
  serverPrimaryExecutionV1: boolean;
  serverPrimaryExecutionClaimRoutingV1: boolean;
  serverPrimaryExecutionBuiltinPassivityV1: boolean;
  /** C1.7: recomputed on EVERY attach (new/resume/takeover), so a takeover
   * from a connection without the subcapability downgrades the session. */
  serverPrimaryExecutionContextLatticeClaimsV1: boolean;
  /** F3: recomputed on every attach, like the other subcapabilities. Gates
   * whether this session may register the `docs` WatchSpec kind. */
  serverPrimaryExecutionDocSetWatchV1: boolean;
  executionFeedSeq: number;
  executionFeedAckSeq: number;
  executionEvents: Array<{
    feedSeq: number;
    event: ExecutionControlEvent;
  }>;
  /** One dominant unacknowledged successful frontier per exact claim. */
  executionSettlementFrontiers: Map<string, ExecutionSettlementFrontier>;
};

type ExecutionEventEntry = SessionState["executionEvents"][number];

const DEFAULT_MAX_EXECUTION_EVENTS = 1024;

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
  readonly #maxExecutionEvents: number;
  #sessions = new Map<string, SessionState>();

  constructor(
    options: { ttlMs?: number; maxExecutionEvents?: number } = {},
  ) {
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#maxExecutionEvents = options.maxExecutionEvents ??
      DEFAULT_MAX_EXECUTION_EVENTS;
    if (
      !Number.isSafeInteger(this.#maxExecutionEvents) ||
      this.#maxExecutionEvents <= 0
    ) {
      throw new TypeError("maxExecutionEvents must be a positive integer");
    }
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
    capabilities: {
      serverPrimaryExecutionV1?: boolean;
      serverPrimaryExecutionClaimRoutingV1?: boolean;
      serverPrimaryExecutionBuiltinPassivityV1?: boolean;
      serverPrimaryExecutionContextLatticeClaimsV1?: boolean;
      serverPrimaryExecutionDocSetWatchV1?: boolean;
    } = {},
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
    const executionFeedSeq = existing?.executionFeedSeq ?? 0;
    const executionFeedAckSeq = Math.min(
      executionFeedSeq,
      Math.max(
        existing?.executionFeedAckSeq ?? 0,
        session.executionFeedSeq ?? 0,
      ),
    );
    // Every reconnect carries a complete claim snapshot plus successful
    // settlement frontiers, so a client older than this retained suffix can
    // restore both authority and overlay reconciliation state.
    const executionEvents = (existing?.executionEvents ?? []).filter((entry) =>
      entry.feedSeq > executionFeedAckSeq
    ).slice(-this.#maxExecutionEvents);
    const executionSettlementFrontiers = new Map(
      [...(existing?.executionSettlementFrontiers ?? new Map())].filter(
        ([, frontier]) => frontier.throughFeedSeq > executionFeedAckSeq,
      ),
    );
    const next: SessionState = {
      id: sessionId,
      space,
      sessionToken,
      seenSeq,
      lastSyncedSeq: existing?.lastSyncedSeq ?? seenSeq,
      watches: existing?.watches ?? [],
      watchScopePrincipal: existing?.watchScopePrincipal,
      graphs: existing?.graphs ?? new Map(),
      entities: existing?.entities ?? new Map(),
      // FA15: doc-set membership survives reconnect so resumed catch-up diffs
      // incrementally against per-member lastSentSeq rather than reseeding.
      docSetMembers: existing?.docSetMembers ?? new Map(),
      docSetMemberRetryKeys: existing?.docSetMemberRetryKeys ?? new Set(),
      trackedIds: existing?.trackedIds ??
        trackedIdsFromEntries(existing?.entities?.values() ?? []),
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      pendingCaughtUpLocalSeq: existing?.pendingCaughtUpLocalSeq ?? 0,
      expiresAt: null,
      ownerConnectionId,
      principal: existing?.principal ?? principal,
      serverPrimaryExecutionV1: capabilities.serverPrimaryExecutionV1 === true,
      serverPrimaryExecutionClaimRoutingV1:
        capabilities.serverPrimaryExecutionClaimRoutingV1 === true,
      serverPrimaryExecutionBuiltinPassivityV1:
        capabilities.serverPrimaryExecutionBuiltinPassivityV1 === true,
      serverPrimaryExecutionContextLatticeClaimsV1:
        capabilities.serverPrimaryExecutionContextLatticeClaimsV1 === true,
      serverPrimaryExecutionDocSetWatchV1:
        capabilities.serverPrimaryExecutionDocSetWatchV1 === true,
      executionFeedSeq,
      executionFeedAckSeq,
      executionEvents,
      executionSettlementFrontiers,
    };
    this.#sessions.set(key, next);
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

  /** FA8 gauge input (FB23): live doc-set member entries summed across every
   * session — the value /api/health/stats exports as docSetMembersTracked.
   * Prunes first so an expired session's members stop counting. */
  totalDocSetMembers(): number {
    this.#prune();
    let total = 0;
    for (const session of this.#sessions.values()) {
      total += session.docSetMembers.size;
    }
    return total;
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

  appendExecutionEvent(
    session: SessionState,
    event: ExecutionControlEvent,
  ): { fromFeedSeq: number; toFeedSeq: number } {
    const fromFeedSeq = session.executionFeedSeq;
    const toFeedSeq = fromFeedSeq + 1;
    session.executionFeedSeq = toFeedSeq;
    session.executionEvents.push({ feedSeq: toFeedSeq, event });
    this.#updateExecutionSettlementFrontier(session, event, toFeedSeq);
    const excess = session.executionEvents.length - this.#maxExecutionEvents;
    if (excess > 0) session.executionEvents.splice(0, excess);
    return { fromFeedSeq, toFeedSeq };
  }

  pruneExecutionEvents(
    session: SessionState,
    acknowledgedFeedSeq: number,
  ): void {
    session.executionFeedAckSeq = Math.max(
      session.executionFeedAckSeq,
      Math.min(acknowledgedFeedSeq, session.executionFeedSeq),
    );
    session.executionEvents = session.executionEvents.filter((entry) =>
      entry.feedSeq > session.executionFeedAckSeq
    ).slice(-this.#maxExecutionEvents);
    session.executionSettlementFrontiers = new Map(
      [...session.executionSettlementFrontiers].filter(([, frontier]) =>
        frontier.throughFeedSeq > session.executionFeedAckSeq
      ),
    );
  }

  #updateExecutionSettlementFrontier(
    session: SessionState,
    event: ExecutionControlEvent,
    feedSeq: number,
  ): void {
    if (event.type === "session.execution.claim.set") {
      const actionKey = actionClaimMapKey(event.claim);
      const incarnation = executionClaimIncarnationKey(event.claim);
      for (const [key, frontier] of session.executionSettlementFrontiers) {
        if (
          actionClaimMapKey(frontier.claim) === actionKey && key !== incarnation
        ) {
          session.executionSettlementFrontiers.delete(key);
        }
      }
      return;
    }
    if (event.type === "session.execution.claim.revoke") {
      const actionKey = actionClaimMapKey(event.claim);
      for (const [key, frontier] of session.executionSettlementFrontiers) {
        if (
          actionClaimMapKey(frontier.claim) === actionKey &&
          frontier.claim.leaseGeneration === event.leaseGeneration &&
          frontier.claim.claimGeneration === event.claimGeneration
        ) {
          session.executionSettlementFrontiers.delete(key);
        }
      }
      return;
    }
    if (
      event.settlement.outcome !== "committed" &&
      event.settlement.outcome !== "no-op"
    ) {
      return;
    }
    const key = executionClaimIncarnationKey(event.settlement.claim);
    const current = session.executionSettlementFrontiers.get(key);
    const requiredAcceptedCommitSeq = event.settlement.outcome === "committed"
      ? current?.requiredAcceptedCommitSeq === undefined ||
          event.settlement.acceptedCommitSeq >
            current.requiredAcceptedCommitSeq
        ? event.settlement.acceptedCommitSeq
        : current.requiredAcceptedCommitSeq
      : current?.requiredAcceptedCommitSeq;
    session.executionSettlementFrontiers.set(key, {
      branch: event.settlement.branch,
      claim: event.settlement.claim,
      inputBasisSeq: current === undefined ||
          event.settlement.inputBasisSeq > current.inputBasisSeq
        ? event.settlement.inputBasisSeq
        : current.inputBasisSeq,
      throughFeedSeq: feedSeq,
      ...(requiredAcceptedCommitSeq === undefined
        ? {}
        : { requiredAcceptedCommitSeq }),
    });
  }

  detach(space: string, sessionId: string, ownerConnectionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session?.ownerConnectionId === ownerConnectionId) {
      session.ownerConnectionId = null;
      session.expiresAt = Date.now() + this.#ttlMs;
    }
  }
}
