import type {
  HarnessChatEventEnvelope,
  HarnessChatSessionStatus,
  HarnessChatTurnLifecycle,
  HarnessChatTurnRecord,
} from "./contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";

export interface HarnessChatSessionSnapshot {
  session: HarnessChatSessionStatus;
  transcript: readonly HarnessTranscriptMessage[];
}

export interface HarnessChatEventListOptions {
  sessionId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface HarnessChatTurnListOptions {
  sessionId?: string;
  status?: HarnessChatTurnLifecycle;
}

export type HarnessMaybePromise<Value> = Value | Promise<Value>;

export interface HarnessChatSessionTurnEventMutation {
  session: HarnessChatSessionSnapshot;
  event: HarnessChatEventEnvelope;
  turn: HarnessChatTurnRecord;
  createTurn?: boolean;
}

/** The service process holding a store. */
export interface HarnessChatStoreHolder {
  /** Identifies one service instance; no two processes share one. */
  instanceId: string;

  /** Operating-system process id of the holder. */
  pid: number;

  /** When the hold was taken. */
  heldSince: string;
}

/** What `HarnessChatSessionStore.hold()` came to. */
export type HarnessChatStoreHoldOutcome =
  | { held: true }
  | {
    held: false;

    /** Who has the store, where its record could be read. */
    holder: HarnessChatStoreHolder | undefined;
  };

export interface HarnessChatSessionStore {
  /**
   * Takes the store for `holder` until it closes, or reports the holder that
   * has it. A store without this member is held by no one, and every service
   * that opens it takes it.
   */
  hold?(
    holder: HarnessChatStoreHolder,
  ): HarnessMaybePromise<HarnessChatStoreHoldOutcome>;
  saveSession(snapshot: HarnessChatSessionSnapshot): HarnessMaybePromise<void>;
  getSession(
    sessionId: string,
  ): HarnessMaybePromise<HarnessChatSessionSnapshot | undefined>;
  listSessions(): HarnessMaybePromise<readonly HarnessChatSessionSnapshot[]>;
  saveSessionAndAppendEvent(
    snapshot: HarnessChatSessionSnapshot,
    event: HarnessChatEventEnvelope,
  ): HarnessMaybePromise<void>;
  saveSessionTurnAndAppendEvent(
    mutation: HarnessChatSessionTurnEventMutation,
  ): HarnessMaybePromise<boolean>;
  saveTurn(turn: HarnessChatTurnRecord): HarnessMaybePromise<void>;
  getTurn(
    sessionId: string,
    turnId: string,
  ): HarnessMaybePromise<HarnessChatTurnRecord | undefined>;
  listTurns(
    options?: HarnessChatTurnListOptions,
  ): HarnessMaybePromise<readonly HarnessChatTurnRecord[]>;
  appendEvent(event: HarnessChatEventEnvelope): HarnessMaybePromise<void>;
  listEvents(
    options?: HarnessChatEventListOptions,
  ): HarnessMaybePromise<readonly HarnessChatEventEnvelope[]>;
  latestSequence(): HarnessMaybePromise<number>;
  close?(): HarnessMaybePromise<void>;
}
