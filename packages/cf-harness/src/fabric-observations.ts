/**
 * What the fabric session's runtime reported while a `run_pattern`
 * invocation settled: action errors attributed to a piece, and
 * convergence-budget episodes in which the scheduler deferred actions after
 * exhausting a pass's budget. `run_pattern` reads these to name the cause
 * when a piece it created settles to an empty or schema-failing result — the
 * two silent shapes observed live were a computation that throws on every
 * rerun, and a commit the CFC boundary refuses, which the scheduler retries
 * and which surfaces nowhere else (CT-2037 tracks giving the refusal a
 * reason channel of its own).
 *
 * One observer is installed per runtime, memoized, because the scheduler's
 * `onError` registry has no removal — a per-invocation subscription would
 * leak a handler per call. Invocations scope their reads by sequence number
 * instead: `sequence()` before the piece starts, `errorsSince`/
 * `episodesSince` after the settle barrier. Both buffers are bounded and drop
 * oldest first; an invocation that reads after heavy churn may therefore
 * miss records, which under-reports causes rather than misattributing them.
 */

import type { Runtime } from "@commonfabric/runner";
import { RuntimeTelemetryEvent } from "@commonfabric/runner";
import { hashStringForEntityAddress } from "@commonfabric/runner/entity-kind";

export interface FabricActionErrorRecord {
  sequence: number;
  pieceId: string;
  patternId: string;
  message: string;
}

export interface FabricDeferredEpisodeRecord {
  sequence: number;
  deferredActions: readonly string[];
  deferredActionCount: number;
}

export interface FabricRuntimeObservations {
  /** Monotonic position; capture before starting a piece. */
  sequence(): number;
  /** Action errors recorded after `since` for the given piece. */
  errorsSince(
    since: number,
    pieceId: string,
  ): readonly FabricActionErrorRecord[];
  /** Convergence-budget episodes recorded after `since`. */
  episodesSince(since: number): readonly FabricDeferredEpisodeRecord[];
}

const BUFFER_LIMIT = 128;

/**
 * The hash both sides of an attribution compare by, through the canonical
 * entity-id seam: `of:` ids reduce to their hash, a bare hash passes
 * through, and a kinded id — which the canonical helper refuses rather than
 * silently aliasing to its `of:` sibling — or an absent id yields
 * `undefined`, so the record never matches instead of matching wrongly. An
 * error without a pattern frame reaches the handler with no `pieceId`
 * despite the declared type, which is why absence is handled rather than
 * assumed away.
 */
const comparableEntityHash = (id: unknown): string | undefined => {
  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  try {
    return hashStringForEntityAddress(id);
  } catch {
    return undefined;
  }
};

const observers = new WeakMap<Runtime, FabricRuntimeObservations>();

export const fabricRuntimeObservations = (
  runtime: Runtime,
): FabricRuntimeObservations => {
  const existing = observers.get(runtime);
  if (existing !== undefined) {
    return existing;
  }
  let sequence = 0;
  const errors: FabricActionErrorRecord[] = [];
  const episodes: FabricDeferredEpisodeRecord[] = [];
  const push = <T>(buffer: T[], record: T): void => {
    buffer.push(record);
    if (buffer.length > BUFFER_LIMIT) {
      buffer.shift();
    }
  };
  runtime.scheduler.onError((error) => {
    // A record that cannot be attributed can never be surfaced, so it is
    // not recorded — and nothing here may throw, because the scheduler
    // walks its error handlers without a guard.
    const pieceHash = comparableEntityHash(error.pieceId);
    if (pieceHash === undefined) {
      return;
    }
    push(errors, {
      sequence: ++sequence,
      pieceId: pieceHash,
      patternId: typeof error.patternId === "string" ? error.patternId : "",
      message: error.message,
    });
  });
  runtime.telemetry.addEventListener("telemetry", (event) => {
    if (!(event instanceof RuntimeTelemetryEvent)) {
      return;
    }
    const marker = event.marker;
    // The `scheduler.non-settling` marker carries two kinds of episode: a
    // convergence-budget pass that deferred named actions, and a busy-window
    // heuristic crossing that defers nothing. Only the first says anything
    // about a specific pattern's writes, so only it is recorded.
    if (
      marker.type !== "scheduler.non-settling" ||
      typeof marker.deferredActionCount !== "number" ||
      marker.deferredActionCount <= 0
    ) {
      return;
    }
    push(episodes, {
      sequence: ++sequence,
      deferredActions: marker.deferredActions ?? [],
      deferredActionCount: marker.deferredActionCount,
    });
  });
  const observations: FabricRuntimeObservations = {
    sequence: () => sequence,
    errorsSince: (since, pieceId) => {
      const wanted = comparableEntityHash(pieceId);
      if (wanted === undefined) {
        return [];
      }
      return errors.filter((record) =>
        record.sequence > since && record.pieceId === wanted
      );
    },
    episodesSince: (since) =>
      episodes.filter((record) => record.sequence > since),
  };
  observers.set(runtime, observations);
  return observations;
};
