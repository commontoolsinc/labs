import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  setPatternSource,
} from "./runner.ts";
import type { Runtime } from "./runtime.ts";

const logger = getLogger("runner.pattern-update", {
  enabled: true,
  level: "warn",
});

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

      let source = storedSource;
      if (source === undefined) {
        if (storedRepository !== undefined) return "current";
        if (mode.kind === "default-root") {
          source = mode.officialSource;
        }
        if (mode.kind === "instantiated") {
          // A sourceless default root remains under the stricter, awaited root
          // policy. In particular, do not turn an author-controlled filename
          // into provenance and bypass its legacy/custom-root admission rules.
          const program = await runtime.patternManager
            .getPatternSourceProgramByIdentity(runningRef.identity, space);
          source = program?.main;
        }
        if (source === undefined) return "current";
      }

      // Published `cf:` refs have a different resolver. This pass is exactly
      // for same-toolshed HTTP sources whose route implements `?identity`.
      if (source.startsWith("cf:")) return "current";
      const host = runtime.mappedHostFor(space) ?? runtime.apiUrl.href;
      const target = new URL(source, host);
      if (target.origin !== new URL(host).origin) return "current";

      const stillMatches = (candidate: Cell<unknown>): boolean => {
        const candidateRef = getPatternIdentityRef(candidate);
        return candidateRef?.identity === runningRef.identity &&
          candidateRef.symbol === runningRef.symbol &&
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
      const repairProvenance = async (): Promise<PatternUpdateOutcome> => {
        const result = await runtime.editWithRetry((tx) => {
          if (!canWrite(tx)) return false;
          setPatternSource(resultCell, tx, source);
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
        runtime.fetch(input, {
          ...init,
          cache: "no-cache",
          signal,
        });
      const identityUrl = new URL(target);
      identityUrl.searchParams.set("identity", "");
      const identityResponse = await revalidatingFetch(identityUrl);
      if (!identityResponse.ok) return "current";
      const advertisedIdentity = (await identityResponse.text()).trim();
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

      if (advertisedIdentity === runningRef.identity) {
        if (mode.kind === "instantiated") {
          return storedSource === undefined
            ? await repairProvenance()
            : "current";
        }
        let loadable = false;
        try {
          loadable = await runtime.patternManager.loadPatternByIdentity(
            runningRef.identity,
            runningRef.symbol,
            space,
          ) !== undefined;
        } catch {
          // Continue through the identity-authorized source path below.
        }
        if (loadable) {
          return storedSource === undefined
            ? await repairProvenance()
            : "current";
        }
      }

      if (signal.aborted) return "current";
      // Default-pattern routes select their official `default` export. Every
      // ordinary source preserves the piece's selected export across versions.
      // Besides matching the root creation contract, this lets a root recover
      // when its persisted symbol itself is obsolete or corrupt.
      const targetSymbol = mode.kind === "default-root"
        ? "default"
        : runningRef.symbol;
      const resolved = await runtime.harness.resolve(
        new HttpProgramResolver(target.href, revalidatingFetch),
      );
      const pattern = await runtime.patternManager.compilePattern(
        { ...resolved, mainExport: targetSymbol },
        { space },
      );
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
      if (
        entryRef.identity === runningRef.identity &&
        entryRef.symbol === runningRef.symbol
      ) {
        return storedSource === undefined
          ? await repairProvenance()
          : "current";
      }

      const result = await runtime.editWithRetry((tx) => {
        if (!canWrite(tx)) return false;
        if (staleSourcelessRoot) {
          resultCell.withTx(tx).setMetaRaw("displacedPattern", {
            identity: runningRef.identity,
            symbol: runningRef.symbol,
            displacedAt: Date.now(),
          });
        }
        resultCell.withTx(tx).setMetaRaw("patternIdentity", entryRef);
        setPatternSource(resultCell, tx, source);
        return true;
      });
      if (result.error) {
        logger.warn("swap-failed", () => [
          "pattern identity swap failed",
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
