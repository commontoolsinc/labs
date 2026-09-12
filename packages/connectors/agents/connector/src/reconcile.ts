import { chunkEvents } from "./chunking.ts";
import { SessionSpool } from "./session-spool.ts";
import { hashStableArrayValue } from "./array-cell-identity.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";
import { sessionKey } from "./session-contract.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SourceDescriptor,
} from "./types.ts";

/** A replayable sequence whose snapshots are read on demand. */
export interface CollectedSessions
  extends AsyncIterable<NativeSessionSnapshot> {
  /** Number of successfully collected snapshots. */
  readonly length: number;
}

export interface CollectedSource {
  source: SourceDescriptor;
  sessions: readonly NativeSessionSnapshot[] | CollectedSessions;
  errors: Array<{ nativeSessionId?: string; message: string }>;
  complete: boolean;
}

export interface PreparedSessionChunk {
  part: number;
  events: unknown[];
  byteLength: number;
  eventCount: number;
  contentHash: string;
}

export interface PreparedSession {
  key: string;
  sourceId: string;
  nativeSessionId: string;
  summary: NativeSessionSnapshot["summary"];
  normalizedMessages: NativeSessionSnapshot["normalizedMessages"];
  chunks: PreparedSessionChunk[];
  complete: boolean;
  revision?: string;
  snapshotHash: string;
}

const MAX_SESSION_SUMMARIES = 100_000;

/**
 * Collects one inventory page at a time and spools each successful snapshot to
 * disk. The caller disposes the result after publication. Provider failures
 * produce an incomplete inventory; spool failures and cancellation reject.
 */
export async function collectSource(
  driver: AgentDriver,
  signal?: AbortSignal,
): Promise<CollectedSource & AsyncDisposable> {
  signal?.throwIfAborted();
  const sessions = await SessionSpool.create();
  try {
    const errors: CollectedSource["errors"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let summaryCount = 0;
    let complete = true;
    while (true) {
      let page;
      try {
        if (cursor && seenCursors.has(cursor)) {
          throw new Error(`repeated session cursor: ${cursor}`);
        }
        if (cursor) seenCursors.add(cursor);
        signal?.throwIfAborted();
        page = await driver.listSessions(cursor);
        signal?.throwIfAborted();
        if (page.sessions.length > MAX_SESSION_SUMMARIES - summaryCount) {
          throw new Error("session enumeration exceeded safety limit");
        }
        summaryCount += page.sessions.length;
      } catch (error) {
        signal?.throwIfAborted();
        errors.push({ message: String(error) });
        complete = false;
        break;
      }
      for (const summary of page.sessions) {
        let snapshot: NativeSessionSnapshot;
        try {
          signal?.throwIfAborted();
          snapshot = await driver.readSession(summary.nativeSessionId);
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          errors.push({
            nativeSessionId: summary.nativeSessionId,
            message: String(error),
          });
          complete = false;
          continue;
        }
        await sessions.append({
          ...snapshot,
          summary: {
            ...snapshot.summary,
            archived: snapshot.summary.archived ?? summary.archived,
            active: snapshot.summary.active ?? summary.active,
          },
        });
        complete &&= snapshot.complete;
        signal?.throwIfAborted();
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return {
      source: driver.source,
      sessions,
      errors,
      complete,
      [Symbol.asyncDispose]: () => sessions[Symbol.asyncDispose](),
    };
  } catch (error) {
    await sessions[Symbol.asyncDispose]();
    throw error;
  }
}

export async function prepareSession(
  sourceId: string,
  snapshot: NativeSessionSnapshot,
  targetChunkBytes?: number,
): Promise<PreparedSession> {
  const summary = stableFabricValue(
    snapshot.summary,
  ) as unknown as NativeSessionSnapshot["summary"];
  const events = stableFabricValue(snapshot.events) as unknown[];
  const normalizedMessages = stableFabricValue(
    snapshot.normalizedMessages,
  ) as unknown as NativeSessionSnapshot["normalizedMessages"];
  const complete = snapshot.complete;
  const revision = snapshot.revision;
  const chunks: PreparedSessionChunk[] = [];
  for (const chunk of chunkEvents(events, targetChunkBytes)) {
    chunks.push({
      ...chunk,
      eventCount: chunk.events.length,
      contentHash: await hashStableArrayValue(chunk.events),
    });
  }
  const base = {
    key: sessionKey(sourceId, summary.nativeSessionId),
    sourceId,
    nativeSessionId: summary.nativeSessionId,
    summary,
    normalizedMessages,
    chunks,
    complete,
    revision,
  };
  return {
    ...base,
    snapshotHash: await hashStableArrayValue({
      ...base,
      chunks: chunks.map(({ part, byteLength, eventCount, contentHash }) => ({
        part,
        byteLength,
        eventCount,
        contentHash,
      })),
    }),
  };
}
