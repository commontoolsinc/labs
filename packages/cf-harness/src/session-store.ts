import type { HarnessCfcModelContext } from "./contracts/cfc-model-context.ts";
import type { HarnessResearchRunSummary } from "./contracts/research.ts";
import type {
  HarnessChatEventEnvelope,
  HarnessChatSessionStatus,
  HarnessChatTurnLifecycle,
  HarnessChatTurnRecord,
} from "./contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";

/** Bounded prior findings plus the full label influence of retained history. */
export interface HarnessChatResearchContext {
  /** User goal established by the first completed task in this context. */
  researchGoal?: string;

  /** Admitted results retained as historical leads for the next root task. */
  runs: readonly HarnessResearchRunSummary[];

  /** Existing model-context accounting, including sources outside selected results. */
  cfcModelContext?: HarnessCfcModelContext;
}

export interface HarnessChatSessionSnapshot {
  session: HarnessChatSessionStatus;
  transcript: readonly HarnessTranscriptMessage[];

  /** Host-owned research context, committed with resumable model history. */
  researchContext?: HarnessChatResearchContext;
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
