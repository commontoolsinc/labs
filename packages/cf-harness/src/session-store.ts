import type {
  HarnessChatEventEnvelope,
  HarnessChatSessionStatus,
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

export type HarnessMaybePromise<Value> = Value | Promise<Value>;

export interface HarnessChatSessionStore {
  saveSession(snapshot: HarnessChatSessionSnapshot): HarnessMaybePromise<void>;
  getSession(
    sessionId: string,
  ): HarnessMaybePromise<HarnessChatSessionSnapshot | undefined>;
  listSessions(): HarnessMaybePromise<readonly HarnessChatSessionSnapshot[]>;
  appendEvent(event: HarnessChatEventEnvelope): HarnessMaybePromise<void>;
  listEvents(
    options?: HarnessChatEventListOptions,
  ): HarnessMaybePromise<readonly HarnessChatEventEnvelope[]>;
  latestSequence(): HarnessMaybePromise<number>;
  close?(): HarnessMaybePromise<void>;
}
