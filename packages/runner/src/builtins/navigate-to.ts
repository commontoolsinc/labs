import {
  effectIntentNonce,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
} from "@commonfabric/memory/v2";
import { type Cell, createCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import { mergeableOpRead } from "../storage/reactivity-log.ts";
import { waveRunContextOf } from "../executor/wave.ts";
import { speculationRunContextOf } from "../speculation/overlay-destination.ts";
import { navigateEventContextOf } from "./navigate-context.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("navigate-to", { enabled: true, level: "warn" });

export function navigateTo(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let isInitialized = false;
  let navigated = false;
  let navigationAttempt = 0;
  let resultCell: Cell<boolean>;
  let resultDocId: string | undefined;
  const targetCellSchema = {
    type: "object",
    properties: {},
    asCell: ["cell"],
  } as const;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      const baseResultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );
      const baseLink = baseResultCell.getAsNormalizedFullLink();
      // The navigateTo INSTANCE identity (server-execution v2 Phase 4,
      // protocol.md §5): cause-derived, so the client's speculative
      // instantiation and the server's authoritative one converge on the
      // same id (speculation.md §2) — which is what makes the
      // deterministic nonce below converge too.
      resultDocId = baseLink.id;
      resultCell = createCell(
        runtime,
        {
          ...baseLink,
          scope: "session",
        },
        tx,
      );

      resultCell.sync();

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole piece
    const inputsWithLog = inputsCell.asSchema(targetCellSchema).withTx(tx);
    const target = inputsWithLog.get();

    // Pattern creation can yield a navigable cell before every reactive
    // dependency has materialized its value. The cell identity is enough for
    // navigation; requiring a current value can block valid piece targets.
    if (!target) return;

    // Resolve to root piece - follows links until path is empty
    const resolvedTarget = target.resolveAsCell();

    // ---- Server-execution v2 Phase 4 (protocol.md §5, builtins.md §4):
    // under the flag, navigateTo is the SPLIT contract. The SERVED half
    // (a wave-stamped run) computes the target and writes the intent into
    // the firing session's effects INSTANCE; the CLIENT half of a flag-ON
    // runtime enacts OPTIMISTICALLY under the speculation overlay,
    // carrying the same deterministic nonce the authoritative intent
    // arrives with. The OFF arm falls through to today's path unchanged.
    if (runtime.experimental.serverExecution === true) {
      const waveContext = waveRunContextOf(tx);
      const speculationContext = speculationRunContextOf(tx);
      if (waveContext !== undefined) {
        servedNavigate(tx, resolvedTarget);
        return;
      }
      if (speculationContext !== undefined) {
        optimisticNavigate(tx, resolvedTarget);
        return;
      }
      // Neither stamp: an unstamped flag-ON run (not a scheduler run —
      // defensive). Fall through to today's path.
    }

    legacyNavigate(tx, resolvedTarget);
  };

  /** The SERVED half (builtins.md §4): compute the target, write the §5
   * intent entry into the ACTING session's effects instance — addressed
   * by the seal-time annotations of an event-handler-stamped
   * transaction whose `scopeKeyIdentity` is the event's server-stamped
   * actor — and set the (session-scoped) result cell in the same
   * transaction. No local enactment: the session's client enacts. */
  function servedNavigate(
    _tx: IExtendedStorageTransaction,
    resolvedTarget: Cell<any>,
  ): void {
    const context = navigateEventContextOf(action);
    if (context === undefined) {
      // No event context: either a navigateTo computed OUTSIDE the
      // consequences of a client-fired event (builtins.md §4's runtime
      // refusal — pure-derivation navigation has no session to address),
      // or a RE-INSTANTIATED builtin from a past fire re-running after a
      // restart/re-demand (its navigation already happened; the durable
      // intent entry and the client-side LT8 journey own any
      // re-enactment). The two are indistinguishable here — the tag
      // lives with the instantiating run — so this arm REFUSES the
      // navigation without wedging the action: no intent is written,
      // nothing navigates, and the refusal is loud in the log.
      logger.warn("served-navigate-refused", () => [
        "navigateTo refused: no firing-event context — navigateTo must " +
        "be reachable only from the consequences of a client-fired " +
        "event (builtins.md §4); a re-instantiated instance whose " +
        "navigation already happened re-runs into this arm harmlessly",
      ]);
      return;
    }
    const acting = context.acting;
    if (acting?.session === undefined) {
      // A sessionless chain (`firedAt.session = "server"` — a
      // derivation-emitted event, a timer) has no client to enact:
      // the SAME runtime error as the sessionless session-scoped write
      // (builtins.md §4; events.md §2; scopes.md §5).
      throw new Error(
        "navigateTo requires an acting SESSION: the event chain is " +
          'sessionless (firedAt.session = "server"), so no client ' +
          "exists to enact the navigation (builtins.md §4)",
      );
    }
    if (
      runtime.connectedSessionProbe !== undefined &&
      !runtime.connectedSessionProbe(acting.user, acting.session)
    ) {
      // LT3 (RULED 2026-08-03): the intent write requires the acting
      // session to be a CONNECTED session of the COMPUTING space — a
      // space the client holds no connection to has no channel to
      // deliver the intent on. Cross-space navigateTo is DEFERRED; the
      // recorded future direction is the client-vended stream target
      // (builtins.md §4).
      throw new Error(
        `navigateTo refused: acting session ${acting.session} is not a ` +
          "connected session of the computing space — cross-space " +
          "navigateTo is deferred (builtins.md §4, LT3)",
      );
    }

    const nonce = effectIntentNonce(context.eventId, resultDocId ?? "");
    const space: MemorySpace = parentCell.space;
    const targetLink = resolvedTarget.getAsNormalizedFullLink();

    const previousNavigated = navigated;
    const thisAttempt = ++navigationAttempt;
    navigated = true;

    const intentTx = runtime.edit();
    runtime.stampServerRun(intentTx, {
      actionId: `server-execution/navigate-intent:${nonce}`,
      kind: "event-handler",
      eventId: context.eventId,
      acting,
      scopeKeyIdentity: {
        principal: acting.user,
        sessionId: acting.session as never,
      },
    });
    intentTx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error && navigationAttempt === thisAttempt) {
        navigated = previousNavigated;
      }
    });

    // The intent append (protocol.md §5's entry shape): a tail-relative
    // MERGEABLE append, the LT1 stream-entry precedent (cell.ts) — the
    // op carries only the appended tail, resolved by the store against
    // the ACTING session's instance (the seal-time annotation supplies
    // the scope key), so the serving replica's scope-NAME-keyed local
    // view (which collapses instances at cardinality > 1 — the OW17
    // residual) never leaks another session's entries into this write.
    // Idempotency is the ENGINE's nonce dedupe at apply
    // (transformEffectsDocOperation): a re-run's re-append of the same
    // deterministic nonce is dropped against the stored instance.
    const entriesLink = {
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
      scope: "session",
      path: ["entries"],
    } as unknown as NormalizedFullLink;
    const currentEntries = intentTx.readValueOrThrow(entriesLink, {
      meta: { ...ignoreReadForScheduling, ...mergeableOpRead },
    });
    const intentEntry = {
      nonce,
      kind: "navigate",
      args: {
        target: {
          ...(targetLink.space !== space ? { space: targetLink.space } : {}),
          id: targetLink.id,
          path: [...targetLink.path],
          ...(targetLink.scope !== undefined
            ? { scope: targetLink.scope }
            : {}),
        },
      },
      // The engine stamps the issuing commit's seq at apply
      // (protocol.md §5's issuedIn; the stream-entry seq precedent).
      issuedIn: null,
    };
    const locallyPresent = Array.isArray(currentEntries) &&
      currentEntries.some((entry) =>
        entry !== null && typeof entry === "object" &&
        (entry as { nonce?: string }).nonce === nonce
      );
    if (!locallyPresent) {
      intentTx.writeValueOrThrow(entriesLink, [
        ...(Array.isArray(currentEntries) ? currentEntries : []),
        intentEntry,
      ] as never);
      intentTx.recordMergeableOp?.(entriesLink, { op: "append", count: 1 });
    }
    // The result cell records the navigation in the ACTING session's
    // instance (the same annotation-keyed addressing) — the client's own
    // speculative write converges on the same instance.
    resultCell.withTx(intentTx).set(true);
    intentTx.commit().catch((error) => {
      logger.warn("intent-commit-failed", () => [
        `navigate intent ${nonce} failed to seal; a requeue or the next ` +
        "input change retries",
        error,
      ]);
    });
    runtime.scheduler.queueExecution();
  }

  /** The flag-ON CLIENT half (speculation.md §2's optimistic enactment):
   * navigation is reversible, so the speculative run still enacts —
   * through the post-commit effect the overlay destination allowlists —
   * carrying the deterministic NONCE so the effects channel records the
   * enactment and the authoritative intent converges on it instead of
   * re-enacting (protocol.md §5; T2.Q7). */
  function optimisticNavigate(
    tx: IExtendedStorageTransaction,
    resolvedTarget: Cell<any>,
  ): void {
    const context = navigateEventContextOf(action);
    if (context === undefined) {
      // Mirror the served half's refusal (builtins.md §4): a navigateTo
      // outside a client-fired event's consequences would optimistically
      // enact a navigation the server will refuse — and a re-instantiated
      // past instance's navigation already happened.
      logger.warn("optimistic-navigate-refused", () => [
        "speculative navigateTo refused: no firing-event context " +
        "(builtins.md §4) — the served half would refuse the same run",
      ]);
      return;
    }
    if (!runtime.navigateCallback) {
      // A flag-ON client with no enactment surface (headless — a CLI,
      // a test runner) skips OPTIMISTIC enactment; the authoritative
      // intent still arrives on the effects channel, and a capable
      // client of the session enacts it (protocol.md §5). Unlike the
      // OFF arm's throw, this run is a speculative ECHO — nothing is
      // lost by not enacting locally.
      logger.warn("optimistic-navigate-skipped", () => [
        "speculative navigateTo skipped: navigateCallback is not set; " +
        "the authoritative intent enacts on a capable client",
      ]);
      return;
    }
    const nonce = effectIntentNonce(context.eventId, resultDocId ?? "");
    const navigateCallback = runtime.navigateCallback;

    const previousNavigated = navigated;
    const thisAttempt = ++navigationAttempt;
    navigated = true;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error && navigationAttempt === thisAttempt) {
        navigated = previousNavigated;
      }
    });
    const targetLink = resolvedTarget.getAsNormalizedFullLink();
    tx.enqueuePostCommitEffect({
      id: `navigateTo:${
        JSON.stringify([
          targetLink.space,
          targetLink.scope,
          targetLink.id,
          targetLink.path,
        ])
      }`,
      kind: "navigateTo",
      // The convergence key (protocol.md §5): the overlay destination
      // records it as ENACTED after a successful flush, and the effects
      // channel acks the authoritative intent without re-enacting.
      nonce,
      flush: async () => {
        if (navigationAttempt !== thisAttempt) return;
        const work = Promise.resolve().then(() =>
          navigateCallback(resolvedTarget)
        );
        runtime.trackAsyncWork(work, parentCell);
        try {
          await work;
        } catch (error) {
          console.error("navigateTo callback failed:", error);
        }
      },
    });
    resultCell.withTx(tx).set(true);
    runtime.scheduler.queueExecution();
  }

  /** Today's client-computed path — the OFF arm, byte-identical. */
  function legacyNavigate(
    tx: IExtendedStorageTransaction,
    resolvedTarget: Cell<any>,
  ): void {
    if (!runtime.navigateCallback) {
      throw new Error("navigateCallback is not set");
    }
    const navigateCallback = runtime.navigateCallback;

    const previousNavigated = navigated;
    const thisAttempt = ++navigationAttempt;
    navigated = true;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error && navigationAttempt === thisAttempt) {
        navigated = previousNavigated;
      }
    });
    // Navigation is an external effect: release it only after a successful
    // commit. The outbox promise is tracked explicitly, owned by this run, so
    // neither runtime.settled() nor runtime.settledFor(parentCell) can race
    // async shell navigation.
    const targetLink = resolvedTarget.getAsNormalizedFullLink();
    tx.enqueuePostCommitEffect({
      // The outbox deduplicates by id within a transaction. Encode the full
      // normalized link as a tuple so scoped targets remain distinct and path
      // segments containing separators cannot collide.
      id: `navigateTo:${
        JSON.stringify([
          targetLink.space,
          targetLink.scope,
          targetLink.id,
          targetLink.path,
        ])
      }`,
      kind: "navigateTo",
      flush: async () => {
        if (navigationAttempt !== thisAttempt) return;
        const work = Promise.resolve().then(() =>
          navigateCallback(resolvedTarget)
        );
        runtime.trackAsyncWork(work, parentCell);
        try {
          await work;
        } catch (error) {
          console.error("navigateTo callback failed:", error);
        }
      },
    });
    resultCell.withTx(tx).set(true);
    runtime.scheduler.queueExecution();
  }

  return {
    action,
    isEffect: true,
    useDeclaredReadsAsDependencies: true,
  };
}
