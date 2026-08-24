// The ExecutorHost (server-execution v2 stage F, serving-loop.md §1):
// one per process, owning the activation policy and one SpaceServer per
// ACTIVE space. Wiring, by plane:
//
// - plane (b): the memory server's admission observer notifies the host
//   on any AUTHORED admission (an admission-side hook, never a poll) and
//   on session open; the host activates the space when it meets the
//   ACTIVE criteria — ≥1 live client session, undelivered events (an
//   event-carrying admission), or an EXPLICIT WARM REQUEST
//   (serving-loop.md §1's third trigger, RULED 2026-08-21): a
//   warm-marked admission notice, set only by the serving-side
//   provisioning path when its wave staged setup into the space, which
//   activates a sessionless target where an ordinary authored write
//   deliberately does not (T11.Q7's write-alone parking);
// - plane (c): lease acquire/renew by direct table write (the
//   SpaceServer's cycle);
// - plane (d): admitted-commit records route to the space's SpaceServer
//   feed (self-echo skipped there by class + holder).
//
// A park racing an incoming commit self-heals: the hook re-fires on the
// next admission. Host boot discovery (stream head past eventWatermark ⇒
// undelivered events ⇒ activate) has nothing to discover until Phase 3;
// spaces activate on their first session, event, warm request, or
// session-implying authored admission.

import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";
import { acquireServerExecutionEnabler } from "@commonfabric/memory/v2";
import { selectPendingStreamEventDocs } from "@commonfabric/memory/v2/engine";
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

// The failure-park re-activation backoff (the lunch-wall cascade flag):
// with park liveness in place, a PERMANENTLY failing loop turns from
// zombie into crash-loop — every admission chains a re-activation, each
// rebuilds a full runtime, fails, and parks (~300 reactivations/s
// observed). Streak-based exponential delay, the same 25·2^n shape as
// the commit-backpressure precedent (scheduler/backpressure.ts), capped;
// a successfully committed wave clears the streak.
const DEFAULT_FAILURE_PARK_BACKOFF_BASE_MS = 25;
const DEFAULT_FAILURE_PARK_BACKOFF_MAX_MS = 30_000;

const failureParkBackoffDelayMs = (
  streak: number,
  policy: SpaceServerPolicy | undefined,
): number => {
  const base = policy?.failureParkBackoffBaseMs ??
    DEFAULT_FAILURE_PARK_BACKOFF_BASE_MS;
  const max = policy?.failureParkBackoffMaxMs ??
    DEFAULT_FAILURE_PARK_BACKOFF_MAX_MS;
  return Math.min(max, base * 2 ** Math.min(streak - 1, 30));
};

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
  /** The RULED test switch for the tenure's space-root ensure (OW45
   * arm-B stage 1, RULED 2026-08-24 — see SpaceServerOptions.
   * ensureSpaceRoots): default ON (production posture); `false`
   * disables it for every SpaceServer this host builds. A
   * whole-instance switch — per-space discrimination is deferred by
   * the same ruling. */
  ensureSpaceRoots?: boolean;
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
  /** The ONE process-lifetime localSeq counter for every sink this host
   * builds (the replay keying — engine-wave-sink.ts): survives
   * park/re-activate, shared across ALL spaces. It must be
   * process-global, not per-space, because every sink commits under the
   * SAME process-stable session id (the DR1 holder) and a HOME space's
   * sink writes FOREIGN provisioning batches into OTHER spaces' engines
   * (protocol.md §2b): with per-space counters, a target space's own
   * sink later re-mints (session, localSeq) pairs the home sink's
   * foreign batches already consumed in that engine, and the engine's
   * replay detection kills the target's waves as "commit replay
   * mismatch" — dropping their derivations with nothing to re-arm them
   * (exposed by the warm request's activation of freshly provisioned
   * spaces; the executor-warm-request pin). One shared monotonic
   * counter makes every (session, localSeq) pair globally unique across
   * writers and engines; per-session localSeq gaps are already normal
   * in every store (the engine keys replay by equality, never
   * contiguity). */
  readonly #sinkLocalSeq = { value: 0 };
  /** Consecutive `loop-failed` parks per space (the re-activation
   * backoff's streak). Incremented at each failure park, cleared by a
   * successfully committed wave — real served progress, not merely a
   * runtime that got built (every crash-loop tenure builds one). */
  readonly #failureParkStreaks = new Map<string, number>();
  /** Wakers for in-flight backoff sleeps — close() flushes them so a
   * delayed re-activation never stalls shutdown. */
  readonly #backoffWakers = new Set<() => void>();
  readonly #stats: ServingLoopStats = emptyServingLoopStats();
  #releaseServerExecution: () => void = () => {};
  #closed = false;

  constructor(options: ExecutorHostOptions) {
    this.#options = options;
    // The host is a PROCESS-level flag ENABLER: while it lives, the
    // ambient flag stays on (the memory server's per-class admission
    // reads it), whatever individual runtimes construct or dispose. The
    // claim is reference-counted with the Runtime enablers' own (the
    // count lives beside the flag), so neither owner's teardown can
    // un-claim `derived` while the other still serves.
    this.#releaseServerExecution = acquireServerExecutionEnabler();
    options.server.setServerExecutionObserver({
      commitAdmitted: (notice) => this.#onCommitAdmitted(notice),
      sessionOpened: (space) => this.#onSessionOpened(space),
      // Fan-out stage B: a watch-set change on an ACTIVE space wakes its
      // demand pass (the arrival re-arm's trigger); an inactive space
      // waits for the session-open / admission activation triggers.
      // The serving runtime's OWN loopback session (the service
      // principal) is dropped: its tracked-set growth is the serving
      // graph's own reads (a wave's derivations re-traversed on push),
      // not client demand — counting it in `pushGrowthWakes` and waking
      // the loop spins an extra cycle + O(closure) pass that finds no
      // client delta (W1 review MINOR-4).
      demandChanged: (space, reason, principal) => {
        if (this.#closed) return;
        if (principal === this.#options.serviceIdentity) return;
        const existing = this.#spaces.get(space);
        if (existing?.active) existing.noteDemandChanged(reason);
      },
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
      // Own copy: the live Record mutates under bumpDerivedCommits and
      // the top-level spread shares its reference (the same reason as
      // NIT-1's settle-series copy below).
      derivedCommitsBySpace: { ...this.#stats.derivedCommitsBySpace },
      events: { ...this.#stats.events },
      demand: { ...this.#stats.demand },
      settle: {
        // NIT-1: deep-copy the entries — a series row stays live after it
        // is pushed (`#recordGrowthLanding` promotes a value-only row to
        // structural-growth in place), so a shallow array copy would let a
        // snapshot's entries mutate after the snapshot was taken.
        series: this.#stats.settle.series.map((entry) => ({ ...entry })),
        dropped: this.#stats.settle.dropped,
      },
      settleAdvances: {
        ...this.#stats.settleAdvances,
        series: this.#stats.settleAdvances.series.map((entry) => ({
          ...entry,
        })),
      },
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
    // Phase 5's server-internal foreign wake needs NO host machinery
    // (survival-tested: a fan-out built here was mutation-probed
    // redundant and removed): a foreign commit's frames arrive on the
    // home serving runtime's foreign loopback session, the scheduler
    // runs autonomously off storage notifications, and the re-run's
    // SEAL wakes the loop (SpaceServer.seal's feed wake). The
    // executor-cross-space E2E pins the end-to-end behavior.
    const existing = this.#spaces.get(notice.space);
    if (existing !== undefined) {
      // Active OR still activating: the record must reach the feed
      // either way — an admission racing a mid-flight activation is the
      // window a dropped record would open (the activation's scan covers
      // only commits before its head). A PARKING server (registered,
      // no longer active, no activation in flight) is the third case:
      // chain a fresh activation behind the park so a space with live
      // demand is never left unserved by the race. A WARM notice racing
      // the park BUFFERS for the successor activation (drained at its
      // registration, exactly like the mid-activation window below):
      // the dying tenure's feed — and the warm capture that just went
      // into it — die with the tenure, and SEVERAL warm notices in one
      // park window chain ONE shared reactivation, so a notice passed
      // by argument would be dropped for every notice but the first
      // (#activate joins the in-flight activation without merging its
      // pending list — the #6191 review's P1).
      existing.enqueueCommit(notice);
      if (!existing.active && !this.#activating.has(notice.space)) {
        if (notice.warm === true) {
          // Only in the true parking window (no successor in flight):
          // once a successor is activating, the enqueue above already
          // reached a feed that survives — its registration drain has
          // either run against this buffer or the notice landed on the
          // registered server directly.
          let buffered = this.#pendingNotices.get(notice.space);
          if (buffered === undefined) {
            buffered = [];
            this.#pendingNotices.set(notice.space, buffered);
          }
          buffered.push(notice);
        }
        this.#reactivateAfterPark(
          existing,
          notice.space as MemorySpace,
          notice.warm === true,
        );
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
    // session or event (trace finding T11.Q7). The one further
    // activation trigger is the EXPLICIT WARM REQUEST (serving-loop.md
    // §1's third trigger; RULED 2026-08-21): a warm-marked notice — set
    // only by the serving-side provisioning path when its wave staged
    // setup into this space — activates like the carries-events arm,
    // sessionless target included. T11.Q7 stays as designed: the
    // admission ALONE still activates nothing; the warm mark is the
    // provisioning run's own deliberate signal, never a property of
    // ordinary writes.
    if (notice.class !== "authored") return;
    const carriesEvents = notice.eventAppends !== undefined &&
      notice.eventAppends.length > 0;
    if (
      !carriesEvents && notice.warm !== true &&
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
    // Activation on session open (serving-loop.md §1), gated on the
    // ACTIVE criteria like the admission and reactivation paths: the
    // service's OWN sessions (loopback planes) are not client demand,
    // and activating on one would hold a runtime and the lease with no
    // client demanding anything.
    if (
      !this.#options.server.hasLiveSessionsForSpace(space, {
        excludePrincipal: this.#options.serviceIdentity,
      })
    ) {
      return;
    }
    void this.#activate(space as MemorySpace, []);
  }

  /** Chain a fresh activation behind a park in progress. Gated on the
   * ACTIVE criteria again at fire time — the park may have been the
   * last session leaving. BOTH §1 criteria are consulted (verdict
   * blocker, 2026-08-12): live sessions OR undelivered events. An
   * event-only admission racing the park (a delegated cross-space
   * delivery with no client anywhere) chains through here, and a
   * sessions-only gate declined it — the delivered event sat unserved
   * until an unrelated trigger. A WARM notice racing the park (`warm`)
   * satisfies the gate the same way — the staged setup is durable and
   * undemanded, exactly the state the warm request exists for. The
   * notice itself travels through `#pendingNotices` (buffered by the
   * caller, drained at the successor's registration), NOT as an
   * argument: several warm notices in one park window share ONE
   * reactivation, and only a buffer merges them all (the #6191
   * review's P1). */
  #reactivateAfterPark(
    parking: SpaceServer,
    space: MemorySpace,
    warm = false,
  ): void {
    void parking.whenParked.then(async () => {
      if (this.#closed || this.#spaces.get(space)?.active) return;
      if (
        !warm &&
        !this.#options.server.hasLiveSessionsForSpace(space, {
          excludePrincipal: this.#options.serviceIdentity,
        })
      ) {
        try {
          const engine = await this.#options.server.engineForSpace(space);
          if (selectPendingStreamEventDocs(engine).length === 0) return;
        } catch (error) {
          logger.warn("reactivate-events-check-failed", () => [
            `space ${space}: undelivered-events check failed after park; ` +
            "not reactivating on it",
            error,
          ]);
          return;
        }
        // The engine read awaited: re-check the activation preconditions.
        if (this.#closed || this.#spaces.get(space)?.active) return;
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
    const streak = this.#failureParkStreaks.get(space) ?? 0;
    if (streak > 0) {
      // Failure-park backoff: the space's last tenure(s) died in
      // `loop-failed` parks. Delay this rebuild; admissions arriving
      // meanwhile buffer into #pendingNotices behind this #activating
      // entry (never dropped, never additional activations).
      const delayMs = failureParkBackoffDelayMs(streak, this.#options.policy);
      this.#stats.reactivationBackoffs += 1;
      logger.warn("reactivation-backoff", () => [
        `space ${space}: ${streak} consecutive failure park(s); ` +
        `delaying re-activation ${delayMs}ms`,
      ]);
      await this.#backoffSleep(delayMs);
      if (this.#closed || this.#spaces.get(space)?.active) return;
    }
    // The warm notices this activation CONSUMES (the argument now; the
    // drained buffer appends at drain time): re-buffered by the failure
    // arms below — see #rebufferConsumedWarm. Collected from the start
    // so an early throw (the engine open) loses nothing either.
    const consumedWarm = pending.filter((notice) => notice.warm === true);
    try {
      const engine = await this.#options.server.engineForSpace(space);
      // The sink's session key IS the DR1 holder, whose process-instance
      // component makes a new process a NEW engine session — so the
      // process-global counter starting at 0 never collides with a prior
      // process's commits, and sharing ONE counter across every space's
      // sink keeps same-process writers from colliding with each OTHER
      // (see #sinkLocalSeq: a home sink's foreign provisioning batches
      // land in other spaces' engines under this same session).
      const localSeqRef = this.#sinkLocalSeq;
      const server = new SpaceServer({
        space,
        server: this.#options.server,
        engine,
        serviceIdentity: this.#options.serviceIdentity,
        createRuntime: () => this.#options.createRuntime(space),
        localSeqRef,
        stats: this.#stats,
        policy: this.#options.policy,
        ...(this.#options.ensureSpaceRoots !== undefined
          ? { ensureSpaceRoots: this.#options.ensureSpaceRoots }
          : {}),
        onParked: (reason) => {
          // The backoff streak: a `loop-failed` park extends it; an
          // idle park (a healthy tenure winding down) clears it. Parks
          // that say nothing about the space's health — lease loss,
          // host close — leave it alone; a committed wave (below) is
          // what clears it on the serving path.
          if (reason === "loop-failed") {
            this.#failureParkStreaks.set(
              space,
              (this.#failureParkStreaks.get(space) ?? 0) + 1,
            );
          } else if (reason === "idle") {
            this.#failureParkStreaks.delete(space);
          }
          // Delete by IDENTITY: a successor activation may already have
          // registered over this entry (the M5 park race), and the
          // dying server must not evict it.
          if (this.#spaces.get(space) === server) {
            this.#spaces.delete(space);
          }
          // No flag re-assert needed: the host's OWN enabler (claimed
          // at construction, shared refcount with Runtime enablers)
          // keeps the ambient flag on until close — a parked runtime's
          // dispose releases only its own claim.
        },
        onWaveCommitted: () => {
          // Real served progress clears the failure streak — the
          // signal a crash-looping tenure never produces (its first
          // wave commit is exactly what fails).
          this.#failureParkStreaks.delete(space);
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
        for (const notice of buffered) {
          if (notice.warm === true) consumedWarm.push(notice);
        }
      }
      const activated = await server.activate();
      if (!activated) {
        this.#spaces.delete(space);
        this.#rebufferConsumedWarm(space, consumedWarm);
        return;
      }
      if (this.#closed) {
        // close() ran while this activation was in flight (it awaits us,
        // but park() on a not-yet-active server is a no-op — so the
        // just-activated server must park itself, or it serves and
        // renews a lease after the host closed).
        await server.park("host-closed");
      }
    } catch (error) {
      this.#spaces.delete(space);
      this.#rebufferConsumedWarm(space, consumedWarm);
      logger.error("activate-failed", `activation of ${space} failed`, error);
    }
  }

  /** Re-buffer the warm notices a FAILED activation consumed — its
   * `pending` argument plus what it drained from `#pendingNotices` —
   * so the next trigger's activation drains them into a live
   * successor. A warm notice is a ONE-SHOT signal from a provisioning
   * wave that has already committed: nothing re-issues it, and in the
   * home-profile shape there is no client backstop — an activation
   * dying AFTER the drain (`activate()` refusing on a rival process's
   * unexpired lease, or throwing) would otherwise strand the staged
   * setup underived with no crash anywhere (the OW46-family
   * no-crash-required loss; pinned in executor-warm-request.test.ts).
   * Prepended: the consumed notices are older than anything buffered
   * while the failed activation was in flight. */
  #rebufferConsumedWarm(
    space: MemorySpace,
    consumedWarm: readonly AdmittedCommitNotice[],
  ): void {
    if (consumedWarm.length === 0) return;
    const standing = this.#pendingNotices.get(space);
    this.#pendingNotices.set(
      space,
      standing === undefined
        ? [...consumedWarm]
        : [...consumedWarm, ...standing],
    );
  }

  /** A cancellable backoff sleep: close() flushes the wakers so a
   * delayed re-activation (which close() awaits through #activating)
   * never stalls shutdown by its full delay. */
  #backoffSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#backoffWakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.#backoffWakers.add(wake);
    });
  }

  /** Park every space and detach from the memory server. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.server.setServerExecutionObserver(undefined);
    registerServingLoopStatsProvider(undefined);
    // Wake sleeping backoffs first: their activations re-check #closed
    // and bail, so the #activating drain below is prompt.
    for (const wake of [...this.#backoffWakers]) wake();
    // Await in-flight activations FIRST: an activation past its #closed
    // check would otherwise register and start serving after close
    // returned (a leaked runtime renewing a lease nobody can take), and
    // park() on a not-yet-active server is a no-op — so the park sweep
    // below cannot stop it. #activateInner's own post-activate check
    // parks the freshly-activated server once #closed is set; awaiting
    // here makes close() cover it. The loop re-checks because a chained
    // re-activation may have been in flight when the snapshot was taken.
    while (this.#activating.size > 0) {
      await Promise.allSettled([...this.#activating.values()]);
    }
    await Promise.all(
      [...this.#spaces.values()].map((server) => server.park("host-closed")),
    );
    this.#spaces.clear();
    this.#pendingNotices.clear();
    // The host's enabler releases; the ambient flag resets only when no
    // other enabler (an explicitly-enabled Runtime) is still live.
    this.#releaseServerExecution();
  }
}
