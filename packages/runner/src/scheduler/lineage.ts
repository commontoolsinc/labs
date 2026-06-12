import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { QueuedEvent } from "./types.ts";

export type OriginStatus = "pending" | "confirmed" | "failed";

interface OriginRecord {
  status: OriginStatus;
  events: Set<QueuedEvent>;
  pieceStops: Array<() => void>;
}

/**
 * Speculation lineage (scheduler-v2 §7.6 / I10): tracks work launched by a
 * transaction so it can be released on commit success or cancelled on
 * failure. Records are created lazily on first launch and removed when the
 * origin settles and its launches are flushed.
 */
export class SpeculationLineage {
  private byOrigin = new Map<IExtendedStorageTransaction, OriginRecord>();

  constructor(
    private readonly hooks: {
      /** Remove a not-yet-dispatched event from the queue. */
      removeQueuedEvent: (event: QueuedEvent) => void;
      /** Wake the scheduler (parked cross-space events become ready). */
      queueExecution: () => void;
      onError: (error: unknown) => void;
    },
  ) {}

  private recordFor(origin: IExtendedStorageTransaction): OriginRecord {
    let record = this.byOrigin.get(origin);
    if (!record) {
      record = { status: "pending", events: new Set(), pieceStops: [] };
      this.byOrigin.set(origin, record);
      origin.addCommitCallback((_tx, result) => {
        const settled = this.byOrigin.get(origin);
        if (!settled) return;
        settled.status = result.error ? "failed" : "confirmed";
        if (result.error) {
          for (const event of settled.events) {
            try {
              this.hooks.removeQueuedEvent(event);
            } catch (error) {
              this.hooks.onError(error);
            }
          }
          settled.events.clear();
          for (const stop of settled.pieceStops) {
            try {
              stop();
            } catch (error) {
              this.hooks.onError(error);
            }
          }
          settled.pieceStops.length = 0;
          this.byOrigin.delete(origin);
        } else {
          // Success: compensation is moot, but the EVENTS must stay
          // registered — still-queued descendants (e.g. cross-space parked
          // ones) keep asking originStatus() until they dispatch and
          // release(). Clearing them here would let the first release()
          // delete the record and strand the rest.
          settled.pieceStops.length = 0;
        }
        this.hooks.queueExecution();
      });
    }
    return record;
  }

  recordEvent(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    this.recordFor(origin).events.add(event);
  }

  recordPieceStop(origin: IExtendedStorageTransaction, stop: () => void): void {
    this.recordFor(origin).pieceStops.push(stop);
  }

  /** Called when an event is dispatched or dropped. */
  release(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    const record = this.byOrigin.get(origin);
    if (!record) return;
    record.events.delete(event);
    if (
      record.status !== "pending" && record.events.size === 0 &&
      record.pieceStops.length === 0
    ) {
      this.byOrigin.delete(origin);
    }
  }

  originStatus(origin: IExtendedStorageTransaction): OriginStatus {
    return this.byOrigin.get(origin)?.status ??
      // Unknown origin ⇒ the record was settled and fully released. A
      // still-queued event always finds its record (failure removes the
      // event synchronously; success keeps the record until release()),
      // so this fallback is only reachable after settlement — and it must
      // be "confirmed": "pending" would park a cross-space event forever,
      // since the commit callback that wakes it has already fired.
      "confirmed";
  }
}
