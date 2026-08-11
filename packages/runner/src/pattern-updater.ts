import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  applyPieceSourceTransition,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceSourceSnapshot,
  type PieceSourceSnapshot,
  type PieceSourceTransition,
  type PieceSourceTransitionBaseline,
  preparePieceSourceTransitionBaseline,
} from "./runner.ts";
import type { Pattern } from "./builder/types.ts";
import {
  parseFabricRef,
  pinnedIdentity,
} from "./sandbox/fabric-import-specifier.ts";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
  systemPatternSourceForModuleName,
} from "./pattern-source-scheme.ts";
import type { Runtime } from "./runtime.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { fabricAuthorityMatchesSpaceHost } from "./space-host.ts";
import {
  isConflictRejection,
  isStorageTransactionInconsistent,
} from "./storage/rejection.ts";

const logger = getLogger("runner.pattern-update", {
  enabled: true,
  level: "warn",
});

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The result of checking one toolshed-backed pattern source. */
export type PatternUpdateOutcome =
  | "updated"
  | "repaired-provenance"
  | "current"
  | "skipped-disabled";

type CheckMode =
  | { kind: "instantiated" }
  | { kind: "default-root"; officialSource: string };

type PendingCheck = {
  abort: AbortController;
  reschedule: boolean;
  promise: Promise<PatternUpdateOutcome>;
};

type FabricFollower = {
  sourceKey: string;
  cancel: () => void;
};

/**
 * Reconciles content-addressed pattern pointers with toolshed source routes.
 *
 * Default roots call the awaited `checkDefaultPattern` path before bootstrap so
 * an unloadable obsolete root can self-heal. Every other instantiated pattern
 * uses `schedule`: its current graph is already live before the source check
 * starts, and a successful pointer swap is applied by Runner's existing
 * `patternIdentity` watcher.
 */
export class PatternUpdater {
  readonly #runtime: Runtime;
  readonly #pending = new Map<string, PendingCheck>();
  readonly #fabricFollowers = new Map<string, FabricFollower>();
  readonly #stoppedFabricFollowers = new Set<string>();
  #disposed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** Start a best-effort check without making instantiation await it. */
  schedule(resultCell: Cell<unknown>): void {
    if (this.#disposed) return;
    try {
      this.#stoppedFabricFollowers.delete(this.#followerKey(resultCell));
      this.#startBackgroundCheck(resultCell);
    } catch (error) {
      // A best-effort background check must not turn a successful
      // instantiation commit into a failed start.
      logger.warn("schedule-failed", () => [
        "could not schedule background pattern update check",
        resultCell.space,
        error,
      ]);
    }
  }

  #startBackgroundCheck(resultCell: Cell<unknown>): void {
    void this.#singleFlight(resultCell, { kind: "instantiated" }).catch(
      (error) => {
        logger.warn("schedule-failed", () => [
          "background pattern update check failed",
          resultCell.space,
          error,
        ]);
      },
    );
  }

  /**
   * Reconcile a space's default root before it starts. `officialSource` is only
   * a candidate for a pre-provenance root; the legacy admission checks below
   * still decide whether that root may track it.
   */
  checkDefaultPattern(
    resultCell: Cell<unknown>,
    officialSource: string,
  ): Promise<PatternUpdateOutcome> {
    if (!this.#runtime.experimental.systemPatternAutoUpdate) {
      return Promise.resolve("skipped-disabled");
    }
    return this.#singleFlight(resultCell, {
      kind: "default-root",
      officialSource,
    });
  }

  /** Resolve when the checks currently in flight have settled. */
  async idle(): Promise<void> {
    await Promise.allSettled(
      [...this.#pending.values()].map(({ promise }) => promise),
    );
  }

  /** Abort network work and keep it away from storage teardown. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const { abort } of this.#pending.values()) abort.abort();
    for (const { cancel } of this.#fabricFollowers.values()) cancel();
    this.#fabricFollowers.clear();
    await this.idle();
  }

  #singleFlight(
    resultCell: Cell<unknown>,
    mode: CheckMode,
  ): Promise<PatternUpdateOutcome> {
    if (this.#disposed) return Promise.resolve("current");
    const link = resultCell.getAsNormalizedFullLink();
    const key = `${mode.kind}\0${link.space}\0${
      link.scope ?? "space"
    }\0${link.id}`;
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      if (existing.abort.signal.aborted) existing.reschedule = true;
      return existing.promise;
    }

    const abort = new AbortController();
    const pending = {} as PendingCheck;
    pending.abort = abort;
    pending.reschedule = false;
    pending.promise = this.#check(resultCell, mode, abort.signal)
      .finally(() => {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
        const followerKey = this.#followerKey(resultCell);
        if (this.#stoppedFabricFollowers.delete(followerKey)) return;
        if (
          pending.reschedule && !this.#disposed
        ) {
          this.#startBackgroundCheck(resultCell);
        }
      });
    this.#pending.set(key, pending);
    return pending.promise;
  }

  #requestCheckAfterCurrent(
    resultCell: Cell<unknown>,
    mode: CheckMode,
  ): boolean {
    const link = resultCell.getAsNormalizedFullLink();
    const key = `${mode.kind}\0${link.space}\0${
      link.scope ?? "space"
    }\0${link.id}`;
    const pending = this.#pending.get(key);
    if (pending === undefined) return false;
    pending.reschedule = true;
    return true;
  }

  #scheduleFromSourceEvent(resultCell: Cell<unknown>): void {
    if (
      this.#disposed ||
      this.#stoppedFabricFollowers.has(this.#followerKey(resultCell))
    ) return;
    if (
      !this.#requestCheckAfterCurrent(resultCell, { kind: "instantiated" })
    ) {
      this.#startBackgroundCheck(resultCell);
    }
  }

  #followerKey(follower: Cell<unknown>): string {
    const link = follower.getAsNormalizedFullLink();
    return `${link.space}\0${link.scope ?? "space"}\0${link.id}`;
  }

  async #check(
    resultCell: Cell<unknown>,
    mode: CheckMode,
    signal: AbortSignal,
  ): Promise<PatternUpdateOutcome> {
    const runtime = this.#runtime;
    const space = resultCell.space;
    try {
      const runningRef = getPatternIdentityRef(resultCell);
      if (runningRef === undefined) return "current";
      const storedSource = getPatternSource(resultCell);
      const storedRepository = getPatternRepository(resultCell);
      const storedSetupRef = getPatternSetupIdentityRef(resultCell);
      const sourceSnapshot = getPieceSourceSnapshot(resultCell)!;
      const followsFabricSource = storedSource?.startsWith("cf:") === true;
      if (!followsFabricSource) this.#unwatchFabricSource(resultCell);
      if (
        !runtime.experimental.systemPatternAutoUpdate &&
        !followsFabricSource
      ) return "current";
      if (storedRepository !== undefined) return "current";

      const host = runtime.mappedHostFor(space) ?? runtime.apiUrl.href;
      let source = storedSource === undefined
        ? undefined
        : normalizePatternSource(storedSource, host);
      if (source === undefined) {
        // A lifecycle revision with no active origin is an intentional detach.
        // Only a history-free legacy piece may have provenance reconstructed.
        if (sourceSnapshot.revisionId !== null) return "current";
        if (mode.kind === "default-root") {
          // `checkDefaultPattern` is exported, and a caller outside this
          // package may still name the official root by its route path. The
          // same rewrite applies, so the repair below stamps the ref either
          // way rather than refusing a caller that spells it the old way.
          source = normalizePatternSource(mode.officialSource, host);
        }
        if (mode.kind === "instantiated") {
          // A sourceless default root remains under the stricter, awaited root
          // policy. In particular, do not turn an author-controlled filename
          // into provenance and bypass its legacy/custom-root admission rules.
          //
          // Reconstruction is limited to an entry document whose name is itself
          // a patterns-route pathname, which is the only case where the name
          // says where the source came from. A program deployed from a file
          // tree names its entry for the compile root instead
          // (`/participant-identity-card.tsx`); resolving that against the host
          // fetched the shell's SPA fallback — 200, with HTML, for any unrouted
          // path — and then compiled the HTML as TSX.
          const program = await runtime.patternManager
            .getPatternSourceProgramByIdentity(runningRef.identity, space);
          source = program === undefined
            ? undefined
            : systemPatternSourceForModuleName(program.main);
        }
        if (source === undefined) return "current";
      }

      if (source.startsWith("cf:")) {
        return await this.#checkFabricSource(
          resultCell,
          source,
          runningRef,
          storedSource,
          storedRepository,
          storedSetupRef,
          sourceSnapshot,
          mode,
          signal,
        );
      }

      // Only a `system:` ref names something the web-backed pass can fetch.
      // Everything else is provenance this pass has no route for.
      const routePath = resolveSystemPatternSource(source);
      if (routePath === undefined) return "current";
      // A piece still carrying a pre-scheme spelling is re-stamped in its
      // canonical form by the repair below, so it migrates on this check.
      const legacyProvenance = storedSource !== undefined &&
        storedSource !== source;
      // Host-relative by construction, so there is no cross-origin case left
      // to refuse: the ref addresses the patterns route of whichever host
      // serves this space.
      const target = new URL(routePath, host);
      const baseline = await preparePieceSourceTransitionBaseline(
        runtime,
        resultCell,
        sourceSnapshot,
        { allowUnavailable: true },
      );

      const stillMatches = (candidate: Cell<unknown>): boolean => {
        const candidateRef = getPatternIdentityRef(candidate);
        const candidateSetupRef = getPatternSetupIdentityRef(candidate);
        return candidateRef?.identity === runningRef.identity &&
          candidateRef.symbol === runningRef.symbol &&
          candidateSetupRef?.identity === storedSetupRef?.identity &&
          candidateSetupRef?.symbol === storedSetupRef?.symbol &&
          getPatternSource(candidate) === storedSource &&
          getPatternRepository(candidate) === storedRepository;
      };
      const canWrite = (tx: IExtendedStorageTransaction): boolean => {
        const candidate = resultCell.withTx(tx);
        if (!stillMatches(candidate)) return false;
        if (mode.kind === "default-root") return true;
        // The default link is independently mutable. Re-read it in the same
        // transaction as the pointer write so promotion while this generic
        // check is in flight participates in OCC and fails closed.
        const defaultPattern = runtime.getSpaceCell(space).withTx(tx)
          .key("defaultPattern").get();
        return defaultPattern === undefined ||
          !defaultPattern.resolveAsCell().equals(candidate.resolveAsCell());
      };
      const sourceTransition = (
        operation: PieceSourceTransition["operation"],
        origin: string,
        transitionBaseline: PieceSourceTransitionBaseline = baseline,
      ): PieceSourceTransition => ({
        revisionId: crypto.randomUUID(),
        baseline: transitionBaseline,
        timestamp: Date.now(),
        operation,
        origin,
        expected: sourceSnapshot,
      });
      const repairProvenance = async (
        transitionBaseline: PieceSourceTransitionBaseline = baseline,
      ): Promise<PatternUpdateOutcome> => {
        // A legacy re-stamp keeps `origin-update`: the origin field does
        // change, even though it names the same route in a new spelling.
        const transition = sourceTransition(
          storedSource === undefined ? "follow" : "origin-update",
          source,
          transitionBaseline,
        );
        const result = await runtime.editWithRetry((tx) => {
          if (!canWrite(tx)) return false;
          applyPieceSourceTransition(
            runtime,
            resultCell,
            tx,
            runningRef,
            transition,
          );
          return true;
        });
        if (result.error) {
          logger.warn("provenance-repair-failed", () => [
            "pattern source provenance repair failed",
            space,
            result.error,
          ]);
          return "current";
        }
        return result.ok ? "repaired-provenance" : "current";
      };

      // Every request in an attempt must revalidate its checksum ETag. The
      // browser may reuse unchanged bytes after a 304, but never without asking
      // the source host whether they are still current.
      const revalidatingFetch: typeof globalThis.fetch = (input, init) =>
        abortable(
          () =>
            runtime.fetch(input, {
              ...init,
              cache: "no-cache",
              signal,
            }),
          signal,
        );
      const identityUrl = new URL(target);
      identityUrl.searchParams.set("identity", "");
      const identityResponse = await revalidatingFetch(identityUrl);
      if (!identityResponse.ok) return "current";
      const advertisedIdentity = (
        await abortable(() => identityResponse.text(), signal)
      ).trim();
      if (advertisedIdentity.length === 0) return "current";

      // The only sourceless roots admitted to the default-root update path are
      // (a) the exact current official default export, whose provenance can be
      // repaired, or (b) a root the current runtime explicitly cannot load. A
      // loadable stale/custom root stays pinned; a failed probe is not evidence.
      const staleSourcelessRoot = mode.kind === "default-root" &&
        storedSource === undefined &&
        (runningRef.identity !== advertisedIdentity ||
          runningRef.symbol !== "default");
      if (staleSourcelessRoot) {
        if (runtime.cfcEnforcementMode === "disabled") return "current";
        try {
          const staleRoot = await runtime.patternManager.loadPatternByIdentity(
            runningRef.identity,
            runningRef.symbol,
            space,
          );
          if (staleRoot !== undefined) return "current";
        } catch (error) {
          logger.warn("stale-root-probe-failed", () => [
            "stale default-pattern load probe failed",
            space,
            runningRef,
            error,
          ]);
          return "current";
        }
      }

      // Default-pattern routes select their official `default` export. Every
      // ordinary source preserves the piece's selected export across versions.
      // Besides matching the root creation contract, this lets a root recover
      // when its persisted symbol itself is obsolete or corrupt.
      const targetSymbol = mode.kind === "default-root"
        ? "default"
        : runningRef.symbol;
      const runningTargetIsAdvertised =
        advertisedIdentity === runningRef.identity &&
        runningRef.symbol === targetSymbol;
      const setupNeedsRepair = mode.kind === "default-root" &&
        runningTargetIsAdvertised &&
        (storedSetupRef?.identity !== runningRef.identity ||
          storedSetupRef?.symbol !== runningRef.symbol);

      let currentPatternNeedingSetup: Pattern | undefined;
      if (runningTargetIsAdvertised) {
        if (
          mode.kind === "instantiated" &&
          baseline.kind === "retain"
        ) {
          return storedSource === undefined || legacyProvenance
            ? await repairProvenance()
            : "current";
        }
        let currentPattern: Pattern | undefined;
        try {
          currentPattern = await runtime.patternManager.loadPatternByIdentity(
            runningRef.identity,
            runningRef.symbol,
            space,
          );
        } catch {
          // Continue through the identity-authorized source path below.
        }
        if (currentPattern !== undefined) {
          if (setupNeedsRepair && baseline.kind === "retain") {
            currentPatternNeedingSetup = currentPattern;
          } else if (
            !setupNeedsRepair &&
            baseline.kind !== "unavailable"
          ) {
            return storedSource === undefined || legacyProvenance
              ? await repairProvenance()
              : "current";
          }
        }
      }

      if (signal.aborted) return "current";
      let pattern: Pattern;
      if (currentPatternNeedingSetup !== undefined) {
        pattern = currentPatternNeedingSetup;
      } else {
        const resolved = await runtime.harness.resolve(
          new HttpProgramResolver(target.href, revalidatingFetch),
        );
        pattern = await runtime.patternManager.compilePattern(
          { ...resolved, mainExport: targetSymbol },
          { space },
        );
      }
      const entryRef = runtime.patternManager.getArtifactEntryRef(pattern);
      if (
        entryRef === undefined ||
        entryRef.identity !== advertisedIdentity ||
        entryRef.symbol !== targetSymbol
      ) {
        logger.warn("compiled-identity-mismatch", () => [
          "compiled pattern source did not match its advertised identity",
          space,
          advertisedIdentity,
          entryRef,
        ]);
        return "current";
      }
      const transitionBaseline: PieceSourceTransitionBaseline =
        baseline.kind === "unavailable" &&
          entryRef.identity === runningRef.identity &&
          entryRef.symbol === runningRef.symbol
          ? { kind: "retain", revisionId: crypto.randomUUID() }
          : baseline;
      if (
        !setupNeedsRepair &&
        entryRef.identity === runningRef.identity &&
        entryRef.symbol === runningRef.symbol
      ) {
        return storedSource === undefined || legacyProvenance ||
            baseline.kind === "unavailable"
          ? await repairProvenance(transitionBaseline)
          : "current";
      }

      if (mode.kind === "instantiated") {
        const previousPattern = await runtime.patternManager
          .loadPatternByIdentity(
            runningRef.identity,
            runningRef.symbol,
            space,
          );
        if (
          previousPattern === undefined ||
          !deepEqual(
            previousPattern.argumentSchema,
            pattern.argumentSchema,
          ) ||
          !deepEqual(previousPattern.resultSchema, pattern.resultSchema)
        ) {
          logger.warn("incompatible-source-update", () => [
            "automatic source update changed the piece contract",
            space,
            runningRef,
            entryRef,
          ]);
          return "current";
        }
      }

      const argumentStillMatches = mode.kind === "default-root"
        ? await runtime.syncStoredSetupArgument(resultCell)
        : undefined;

      const transition = sourceTransition(
        "origin-update",
        source,
        transitionBaseline,
      );
      const result = await runtime.editWithRetry((tx) => {
        if (!canWrite(tx)) return false;
        const candidate = resultCell.withTx(tx);
        if (
          argumentStillMatches !== undefined &&
          !argumentStillMatches(candidate)
        ) {
          return false;
        }
        applyPieceSourceTransition(
          runtime,
          resultCell,
          tx,
          entryRef,
          transition,
        );
        if (
          staleSourcelessRoot ||
          transitionBaseline.kind === "unavailable"
        ) {
          candidate.setMetaRaw("displacedPattern", {
            identity: runningRef.identity,
            symbol: runningRef.symbol,
            displacedAt: Date.now(),
          });
        }
        if (mode.kind === "default-root") {
          void runtime.setup(tx, pattern, undefined, candidate, {
            prepareForResume: true,
            ...(setupNeedsRepair ? { reapplyStoredSetup: true } : {}),
          });
        } else {
          candidate.setMetaRaw("patternIdentity", entryRef);
        }
        return true;
      });
      if (result.error) {
        logger.warn("swap-failed", () => [
          "pattern update setup failed",
          space,
          result.error,
        ]);
        return "current";
      }
      return result.ok ? "updated" : "current";
    } catch (error) {
      if (signal.aborted) return "current";
      logger.warn("check-failed", () => [
        "pattern update check failed",
        space,
        error,
      ]);
      return "current";
    }
  }

  async #checkFabricSource(
    resultCell: Cell<unknown>,
    source: string,
    runningRef: { identity: string; symbol: string },
    storedSource: string | undefined,
    storedRepository: string | undefined,
    storedSetupRef: { identity: string; symbol: string } | undefined,
    sourceSnapshot: PieceSourceSnapshot,
    mode: CheckMode,
    signal: AbortSignal,
  ): Promise<PatternUpdateOutcome> {
    if (mode.kind !== "instantiated") return "current";
    const runtime = this.#runtime;
    const destinationSpace = resultCell.space;
    const ref = parseFabricRef(source);
    if (
      ref === undefined || ref.subpath !== undefined ||
      ref.ref.kind !== "uri"
    ) {
      this.#unwatchFabricSource(resultCell);
      return "current";
    }
    const sourceSpaceValue = ref.space === undefined
      ? destinationSpace
      : ref.space;
    if (!sourceSpaceValue.startsWith("did:")) return "current";
    const sourceSpace = sourceSpaceValue as typeof destinationSpace;
    if (ref.host !== undefined) {
      const routedHost = runtime.hostForSpace(sourceSpace);
      if (
        !fabricAuthorityMatchesSpaceHost(ref.host, routedHost)
      ) {
        this.#unwatchFabricSource(resultCell);
        return "current";
      }
    }

    let targetRef: { identity: string; symbol: string };
    const pinned = pinnedIdentity(ref);
    if (pinned !== undefined) {
      this.#unwatchFabricSource(resultCell);
      targetRef = { identity: pinned, symbol: runningRef.symbol };
    } else {
      const sourceCell = runtime.getCellFromEntityId(
        sourceSpace,
        `${ref.ref.scheme}:fid1:${ref.ref.hash}`,
      );
      await abortable(() => sourceCell.sync().then(() => undefined), signal);
      if (
        signal.aborted ||
        this.#stoppedFabricFollowers.has(this.#followerKey(resultCell))
      ) return "current";
      const current = getPatternIdentityRef(sourceCell);
      if (current === undefined) return "current";
      targetRef = current;
      this.#watchFabricSource(resultCell, sourceCell, source, targetRef);
    }
    if (
      targetRef.identity === runningRef.identity &&
      targetRef.symbol === runningRef.symbol
    ) return "current";

    const program = await runtime.patternManager
      .getPatternSourceProgramByIdentity(
        targetRef.identity,
        sourceSpace,
        destinationSpace,
      );
    if (program === undefined || signal.aborted) return "current";
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      resultCell,
      sourceSnapshot,
    );
    const pattern = await runtime.patternManager.compilePattern(
      { ...program, mainExport: targetRef.symbol },
      { space: destinationSpace },
    );
    const entryRef = runtime.patternManager.getArtifactEntryRef(pattern);
    if (
      entryRef === undefined || entryRef.identity !== targetRef.identity ||
      entryRef.symbol !== targetRef.symbol
    ) return "current";

    const previousPattern = await runtime.patternManager.loadPatternByIdentity(
      runningRef.identity,
      runningRef.symbol,
      destinationSpace,
    );
    if (
      previousPattern === undefined ||
      !deepEqual(previousPattern.argumentSchema, pattern.argumentSchema) ||
      !deepEqual(previousPattern.resultSchema, pattern.resultSchema)
    ) {
      logger.warn("incompatible-fabric-source-update", () => [
        "automatic fabric source update changed the piece contract",
        destinationSpace,
        runningRef,
        entryRef,
      ]);
      return "current";
    }

    const stillMatches = (candidate: Cell<unknown>): boolean => {
      const candidateRef = getPatternIdentityRef(candidate);
      const candidateSetupRef = getPatternSetupIdentityRef(candidate);
      return candidateRef?.identity === runningRef.identity &&
        candidateRef.symbol === runningRef.symbol &&
        candidateSetupRef?.identity === storedSetupRef?.identity &&
        candidateSetupRef?.symbol === storedSetupRef?.symbol &&
        getPatternSource(candidate) === storedSource &&
        getPatternRepository(candidate) === storedRepository;
    };
    const tx = runtime.edit();
    try {
      if (this.#stoppedFabricFollowers.has(this.#followerKey(resultCell))) {
        tx.abort?.("fabric follower stopped");
        return "current";
      }
      const candidate = resultCell.withTx(tx);
      if (!stillMatches(candidate)) {
        tx.abort?.("fabric source changed before update");
        return "current";
      }
      const defaultPattern = runtime.getSpaceCell(destinationSpace).withTx(tx)
        .key("defaultPattern").get();
      if (
        defaultPattern !== undefined &&
        defaultPattern.resolveAsCell().equals(candidate.resolveAsCell())
      ) {
        tx.abort?.("default pattern uses its dedicated update path");
        return "current";
      }
      applyPieceSourceTransition(runtime, resultCell, tx, entryRef, {
        revisionId: crypto.randomUUID(),
        baseline,
        timestamp: Date.now(),
        operation: "origin-update",
        origin: source,
        expected: sourceSnapshot,
      });
      void runtime.setup(tx, pattern, undefined, candidate, {
        prepareForResume: true,
      });
      if (
        signal.aborted ||
        this.#stoppedFabricFollowers.has(this.#followerKey(resultCell))
      ) {
        tx.abort?.("fabric follower stopped before update");
        return "current";
      }
      runtime.prepareTxForCommit(tx);
      const result = await tx.commit();
      if (result.error) {
        logger.warn("fabric-source-swap-failed", () => [
          "fabric source update commit failed",
          destinationSpace,
          result.error,
        ]);
        if (isConflictRejection(result.error)) {
          const readyToRetry = (result.error as {
            readyToRetry?: () => Promise<unknown> | unknown;
          }).readyToRetry;
          if (typeof readyToRetry === "function") {
            try {
              await readyToRetry();
              this.#scheduleFromSourceEvent(resultCell);
            } catch {
              // The readiness notification ended before the state arrived.
            }
          }
        } else if (isStorageTransactionInconsistent(result.error)) {
          this.#requestCheckAfterCurrent(resultCell, mode);
        }
        return "current";
      }
      return "updated";
    } catch (error) {
      tx.abort?.("fabric source update failed");
      throw error;
    }
  }

  #watchFabricSource(
    follower: Cell<unknown>,
    source: Cell<unknown>,
    origin: string,
    targetRef: { identity: string; symbol: string },
  ): void {
    const followerLink = follower.getAsNormalizedFullLink();
    const sourceLink = source.getAsNormalizedFullLink();
    const followerKey = `${followerLink.space}\0${
      followerLink.scope ?? "space"
    }\0${followerLink.id}`;
    const sourceKey = `${origin}\0${sourceLink.space}\0${
      sourceLink.scope ?? "space"
    }\0${sourceLink.id}`;
    const existing = this.#fabricFollowers.get(followerKey);
    if (existing?.sourceKey === sourceKey) return;
    existing?.cancel();
    let sourcePrimed = false;
    const cancelSource = source.sinkMeta("patternIdentity", (value) => {
      if (!sourcePrimed) {
        sourcePrimed = true;
        const candidate = value as Record<string, unknown>;
        if (
          typeof value === "object" && value !== null &&
          !Array.isArray(value) &&
          candidate.identity === targetRef.identity &&
          candidate.symbol === targetRef.symbol
        ) return;
      }
      this.#scheduleFromSourceEvent(follower);
    });
    let followerPrimed = false;
    const cancelFollower = follower.sinkMeta("patternSource", (value) => {
      if (!followerPrimed) {
        followerPrimed = true;
        if (value === origin) return;
      }
      this.#scheduleFromSourceEvent(follower);
    });
    this.#fabricFollowers.set(followerKey, {
      sourceKey,
      cancel: () => {
        cancelSource();
        cancelFollower();
      },
    });
  }

  /** Stop following a source when its piece stops. */
  unwatch(resultCell: Cell<unknown>): void {
    const key = this.#followerKey(resultCell);
    const pendingKey = `instantiated\0${key}`;
    const pending = this.#pending.get(pendingKey);
    if (pending !== undefined) {
      this.#stoppedFabricFollowers.add(key);
      pending.abort.abort("fabric follower stopped");
    } else {
      this.#stoppedFabricFollowers.delete(key);
    }
    this.#unwatchFabricSource(resultCell);
  }

  #unwatchFabricSource(follower: Cell<unknown>): void {
    const key = this.#followerKey(follower);
    this.#fabricFollowers.get(key)?.cancel();
    this.#fabricFollowers.delete(key);
  }
}
