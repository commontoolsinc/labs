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

export interface HarnessChatSessionStore {
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
