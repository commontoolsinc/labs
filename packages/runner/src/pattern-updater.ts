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
  type PieceSourceTransition,
  type PieceSourceTransitionBaseline,
  preparePieceSourceTransitionBaseline,
} from "./runner.ts";
import type { Pattern } from "./builder/types.ts";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
  systemPatternSourceForModuleName,
} from "./pattern-source-scheme.ts";
import type { Runtime } from "./runtime.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";

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
  promise: Promise<PatternUpdateOutcome>;
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
  #disposed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** Start a best-effort check without making instantiation await it. */
  schedule(resultCell: Cell<unknown>): void {
    if (
      this.#disposed ||
      !this.#runtime.experimental.systemPatternAutoUpdate
    ) return;
    try {
      void this.#singleFlight(resultCell, { kind: "instantiated" }).catch(
        (error) => {
          logger.warn("schedule-failed", () => [
            "background pattern update check failed",
            resultCell.space,
            error,
          ]);
        },
      );
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
    if (existing !== undefined) return existing.promise;

    const abort = new AbortController();
    const pending = {} as PendingCheck;
    pending.abort = abort;
    pending.promise = this.#check(resultCell, mode, abort.signal)
      .finally(() => {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
      });
    this.#pending.set(key, pending);
    return pending.promise;
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

      // Only a `system:` ref names something this pass can fetch. A `cf:` ref
      // has its own resolver, and everything else is provenance this pass has
      // no route for.
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
          // Prepare the complete replacement graph atomically with the source
          // transition and pointer. A bare pointer write could let the watcher
          // start new nodes against an old manifest, schema, or projection.
          void runtime.setup(tx, pattern, undefined, candidate);
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
}
