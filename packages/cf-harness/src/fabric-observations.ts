/**
 * What the fabric session's runtime reported while a `run_pattern`
 * invocation settled: action errors attributed to a piece, and non-settling
 * episodes in which the scheduler deferred actions after exhausting a pass's
 * convergence budget. `run_pattern` reads these to name the cause when a
 * piece it created settles to an empty or schema-failing result — the two
 * silent shapes observed live were a computation that throws on every rerun,
 * and a commit the CFC boundary refuses, which the scheduler retries and
 * which surfaces nowhere else (CT-2037 tracks giving the refusal a reason
 * channel of its own).
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
  /** Non-settling episodes recorded after `since`. */
  episodesSince(since: number): readonly FabricDeferredEpisodeRecord[];
}

const BUFFER_LIMIT = 128;

/** `of:fid1:…` and `fid1:…` name the same entity at different seams. */
const normalizedPieceId = (id: string): string =>
  id.startsWith("of:") ? id.slice("of:".length) : id;

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
    push(errors, {
      sequence: ++sequence,
      pieceId: normalizedPieceId(error.pieceId),
      patternId: error.patternId,
      message: error.message,
    });
  });
  runtime.telemetry.addEventListener("telemetry", (event) => {
    if (!(event instanceof RuntimeTelemetryEvent)) {
      return;
    }
    const marker = event.marker;
    if (marker.type !== "scheduler.non-settling") {
      return;
    }
    push(episodes, {
      sequence: ++sequence,
      deferredActions: marker.deferredActions ?? [],
      deferredActionCount: marker.deferredActionCount ?? 0,
    });
  });
  const observations: FabricRuntimeObservations = {
    sequence: () => sequence,
    errorsSince: (since, pieceId) => {
      const wanted = normalizedPieceId(pieceId);
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
