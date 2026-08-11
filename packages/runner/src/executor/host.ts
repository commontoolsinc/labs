// The ExecutorHost (server-execution v2 stage F, serving-loop.md §1):
// one per process, owning the activation policy and one SpaceServer per
// ACTIVE space. Wiring, by plane:
//
// - plane (b): the memory server's admission observer notifies the host
//   on any AUTHORED admission (an admission-side hook, never a poll) and
//   on session open; the host activates the space when it meets the
//   ACTIVE criteria (≥1 live client session or undelivered events — the
//   latter has no instances until Phase 3 lands events on the wire);
// - plane (c): lease acquire/renew by direct table write (the
//   SpaceServer's cycle);
// - plane (d): admitted-commit records route to the space's SpaceServer
//   feed (self-echo skipped there by class + holder).
//
// A park racing an incoming commit self-heals: the hook re-fires on the
// next admission. Host boot discovery (stream head past eventWatermark ⇒
// undelivered events ⇒ activate) has nothing to discover until Phase 3;
// spaces activate on their first session or authored admission.

import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { SpaceServer, type SpaceServerPolicy } from "./space-server.ts";
import {
  emptyServingLoopStats,
  registerServingLoopStatsProvider,
  type ServingLoopStats,
} from "./stats.ts";

const logger = getLogger("executor-host", { enabled: true, level: "warn" });

export type ExecutorHostOptions = {
  server: MemoryServer;
  /** The service identity (DID) DR1 holders are minted from — also the
   * loopback sessions' principal (the read-row admission matches it,
   * protocol.md §2). */
  serviceIdentity: string;
  /** Build a serving runtime for one space over the loopback plane. The
   * factory owns auth and runtime options; it MUST pass
   * `experimental: { serverExecution: true, systemPatternAutoUpdate:
   * true }` — the flag posture and §3e's server-side pattern-update
   * flip. */
  createRuntime: (space: MemorySpace) => Promise<{
    runtime: Runtime;
    dispose: () => Promise<void>;
  }>;
  policy?: SpaceServerPolicy;
};

export class ExecutorHost {
  readonly #options: ExecutorHostOptions;
  readonly #spaces = new Map<string, SpaceServer>();
  readonly #activating = new Map<string, Promise<void>>();
  /** Records admitted while a space's activation is still in flight
   * (before its SpaceServer registers): buffered here, drained into the
   * feed at registration — an admission racing activation must never be
   * dropped (its seq may pass the activation's scan head). */
  readonly #pendingNotices = new Map<string, AdmittedCommitNotice[]>();
  /** Process-lifetime localSeq counters per space (the sink's replay
   * keying — engine-wave-sink.ts): survive park/re-activate, floored at
   * the engine's stored max on first use. */
  readonly #localSeqBySpace = new Map<string, { value: number }>();
  readonly #stats: ServingLoopStats = emptyServingLoopStats();
  #closed = false;

  constructor(options: ExecutorHostOptions) {
    this.#options = options;
    // The host owns the PROCESS-level flag lifecycle: while it lives,
    // the ambient flag stays on (the memory server's per-class admission
    // reads it), whatever individual runtimes construct or dispose.
    setServerExecutionConfig(true);
    options.server.setServerExecutionObserver({
      commitAdmitted: (notice) => this.#onCommitAdmitted(notice),
      sessionOpened: (space) => this.#onSessionOpened(space),
    });
    registerServingLoopStatsProvider(() => this.stats());
  }

  /** The §7 counters, live: static counts merged with per-space state
   * (activeSpaces and watermarkLag read the current SpaceServers). */
  stats(): ServingLoopStats {
    let watermarkLag = 0;
    let activeSpaces = 0;
    for (const server of this.#spaces.values()) {
      if (!server.active) continue;
      activeSpaces += 1;
      watermarkLag = Math.max(watermarkLag, server.watermarkLag);
    }
    return {
      ...this.#stats,
      events: { ...this.#stats.events },
      memo: { ...this.#stats.memo },
      outbox: { ...this.#stats.outbox },
      lease: { ...this.#stats.lease },
      activeSpaces,
      watermarkLag,
    };
  }

  spaceServer(space: MemorySpace): SpaceServer | undefined {
    return this.#spaces.get(space);
  }

  #onCommitAdmitted(notice: AdmittedCommitNotice): void {
    if (this.#closed) return;
    const existing = this.#spaces.get(notice.space);
    if (existing !== undefined) {
      // Active OR still activating: the record must reach the feed
      // either way — an admission racing a mid-flight activation is the
      // window a dropped record would open (the activation's scan covers
      // only commits before its head). A PARKING server (registered,
      // no longer active, no activation in flight) is the third case:
      // chain a fresh activation behind the park so a space with live
      // demand is never left unserved by the race.
      existing.enqueueCommit(notice);
      if (!existing.active && !this.#activating.has(notice.space)) {
        this.#reactivateAfterPark(existing, notice.space as MemorySpace);
      }
      return;
    }
    const activating = this.#activating.get(notice.space);
    if (activating !== undefined) {
      // Activation started but its SpaceServer has not registered yet
      // (engine open in flight): buffer, drained at registration.
      let buffered = this.#pendingNotices.get(notice.space);
      if (buffered === undefined) {
        buffered = [];
        this.#pendingNotices.set(notice.space, buffered);
      }
      buffered.push(notice);
      return;
    }
    // The admission-side activation hook (serving-loop.md §1 plane (b)):
    // an AUTHORED admission into a space with no live SpaceServer. The
    // ACTIVE criteria then gate activation: ≥1 live session (an authored
    // transact implies its committing session) or undelivered events —
    // an event-append admission is BOTH the event's arrival and the
    // criterion, so it activates even with no live session (Phase 3: a
    // delegated cross-space delivery lands under the DELIVERING
    // server's service session, and the target may have no client).
    // System/direct writes alone activate nothing — a provisioning
    // write into a lease-less space stays parked until its first
    // session or event (trace finding T11.Q7).
    if (notice.class !== "authored") return;
    const carriesEvents = notice.eventAppends !== undefined &&
      notice.eventAppends.length > 0;
    if (
      !carriesEvents &&
      !this.#options.server.hasLiveSessionsForSpace(notice.space, {
        excludePrincipal: this.#options.serviceIdentity,
      })
    ) {
      return;
    }
    void this.#activate(notice.space as MemorySpace, [notice]);
  }

  #onSessionOpened(space: string): void {
    if (this.#closed) return;
    const existing = this.#spaces.get(space);
    if (existing?.active) {
      existing.noteDemandChanged();
      return;
    }
    if (existing !== undefined && !this.#activating.has(space)) {
      // A park in progress: re-activate once it completes (M5 — a
      // session opening against a mid-park space must not be stranded
      // until the next trigger).
      this.#reactivateAfterPark(existing, space as MemorySpace);
      return;
    }
    // Activation on session open (serving-loop.md §1).
    void this.#activate(space as MemorySpace, []);
  }

  /** Chain a fresh activation behind a park in progress. Gated on the
   * ACTIVE criteria again at fire time — the park may have been the
   * last session leaving. */
  #reactivateAfterPark(parking: SpaceServer, space: MemorySpace): void {
    void parking.whenParked.then(() => {
      if (this.#closed || this.#spaces.get(space)?.active) return;
      if (
        !this.#options.server.hasLiveSessionsForSpace(space, {
          excludePrincipal: this.#options.serviceIdentity,
        })
      ) {
        return;
      }
      void this.#activate(space, []);
    });
  }

  #activate(
    space: MemorySpace,
    pending: AdmittedCommitNotice[],
  ): Promise<void> {
    // One activation in flight per space: session-open and
    // commit-admitted hooks race, and a second concurrent activation
    // would double-build runtimes against one lease.
    const inFlight = this.#activating.get(space);
    if (inFlight !== undefined) return inFlight;
    const activation = this.#activateInner(space, pending).finally(() => {
      this.#activating.delete(space);
    });
    this.#activating.set(space, activation);
    return activation;
  }

  async #activateInner(
    space: MemorySpace,
    pending: AdmittedCommitNotice[],
  ): Promise<void> {
    if (this.#closed || this.#spaces.get(space)?.active) return;
    try {
      const engine = await this.#options.server.engineForSpace(space);
      let localSeqRef = this.#localSeqBySpace.get(space);
      if (localSeqRef === undefined) {
        // Fresh per (space, process): the sink's session key IS the DR1
        // holder, whose process-instance component makes a new process a
        // NEW engine session — no stored localSeqs to collide with, so
        // the counter starts at 0. Same-process park/re-activate reuses
        // this ref, which is the whole replay-keying obligation
        // (engine-wave-sink.ts). A holder scheme WITHOUT a process
        // component would need a stored-max floor here instead; no such
        // scheme exists, so none is kept.
        localSeqRef = { value: 0 };
        this.#localSeqBySpace.set(space, localSeqRef);
      }
      const server = new SpaceServer({
        space,
        server: this.#options.server,
        engine,
        serviceIdentity: this.#options.serviceIdentity,
        createRuntime: () => this.#options.createRuntime(space),
        localSeqRef,
        stats: this.#stats,
        policy: this.#options.policy,
        onParked: () => {
          // Delete by IDENTITY: a successor activation may already have
          // registered over this entry (the M5 park race), and the
          // dying server must not evict it.
          if (this.#spaces.get(space) === server) {
            this.#spaces.delete(space);
          }
          // Belt over the refcounted ambient lifecycle (Runtime.dispose
          // resets only when the LAST explicit enabler goes): the
          // process still serves, so re-assert until close.
          if (!this.#closed) setServerExecutionConfig(true);
        },
      });
      // Register BEFORE the async activation so admissions racing it
      // enqueue into the feed rather than being dropped; the SpaceServer
      // itself filters records its activation scan already covers.
      this.#spaces.set(space, server);
      for (const notice of pending) server.enqueueCommit(notice);
      const buffered = this.#pendingNotices.get(space);
      if (buffered !== undefined) {
        this.#pendingNotices.delete(space);
        for (const notice of buffered) server.enqueueCommit(notice);
      }
      const activated = await server.activate();
      if (!activated) {
        this.#spaces.delete(space);
      }
    } catch (error) {
      this.#spaces.delete(space);
      logger.error("activate-failed", `activation of ${space} failed`, error);
    }
  }

  /** Park every space and detach from the memory server. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.server.setServerExecutionObserver(undefined);
    registerServingLoopStatsProvider(undefined);
    await Promise.all(
      [...this.#spaces.values()].map((server) => server.park("host-closed")),
    );
    this.#spaces.clear();
    // The process stops serving: the ambient flag returns to its default.
    resetServerExecutionConfig();
  }
}
