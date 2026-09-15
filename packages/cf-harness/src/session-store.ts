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

/** The process holding a store. */
export interface HarnessChatStoreHolder {
  /** Identifies one opening of the store; no two processes share one. */
  instanceId: string;

  /** Operating-system process id of the holder. */
  pid: number;

  /** When the hold was taken. */
  heldSince: string;
}

/**
 * The store is held by another live process. Nothing was opened, read, or
 * written: the turns that store holds open are that process's work in
 * progress.
 */
export class HarnessChatStoreHeldError extends Error {
  readonly #store: string;
  readonly #holder: HarnessChatStoreHolder | undefined;

  /**
   * Constructs an instance for the database at `store`, naming `holder`
   * where its record could be read.
   */
  constructor(store: string, holder: HarnessChatStoreHolder | undefined) {
    super(
      holder === undefined
        ? `cf-harness chat session store ${store} is held by another live process`
        : `cf-harness chat session store ${store} is held by another live process: instance ${holder.instanceId}, pid ${holder.pid}, since ${holder.heldSince}`,
    );
    this.name = "HarnessChatStoreHeldError";
    this.#store = store;
    this.#holder = holder;
  }

  /** The database's path, resolved through every link. */
  get store(): string {
    return this.#store;
  }

  /** Who holds the store, where its record could be read at refusal. */
  get holder(): HarnessChatStoreHolder | undefined {
    return this.#holder;
  }
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
