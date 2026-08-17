import { chunkEvents } from "./chunking.ts";
import { hashStableArrayValue } from "./array-cell-identity.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";
import { sessionKey } from "./session-contract.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SourceDescriptor,
} from "./types.ts";

export interface CollectedSource {
  source: SourceDescriptor;
  sessions: NativeSessionSnapshot[];
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

export async function collectSource(
  driver: AgentDriver,
  signal?: AbortSignal,
): Promise<CollectedSource> {
  signal?.throwIfAborted();
  const summaries = [];
  const errors: CollectedSource["errors"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let enumerationComplete = false;
  try {
    while (true) {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`repeated session cursor: ${cursor}`);
      }
      if (cursor) seenCursors.add(cursor);
      signal?.throwIfAborted();
      const page = await driver.listSessions(cursor);
      signal?.throwIfAborted();
      if (page.sessions.length > MAX_SESSION_SUMMARIES - summaries.length) {
        throw new Error("session enumeration exceeded safety limit");
      }
      summaries.push(...page.sessions);
      if (!page.nextCursor) {
        enumerationComplete = true;
        break;
      }
      cursor = page.nextCursor;
    }
  } catch (error) {
    signal?.throwIfAborted();
    errors.push({ message: String(error) });
  }

  const sessions: NativeSessionSnapshot[] = [];
  for (const summary of summaries) {
    try {
      signal?.throwIfAborted();
      const snapshot = await driver.readSession(summary.nativeSessionId);
      sessions.push({
        ...snapshot,
        summary: {
          ...snapshot.summary,
          archived: snapshot.summary.archived ?? summary.archived,
          active: snapshot.summary.active ?? summary.active,
        },
      });
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      errors.push({
        nativeSessionId: summary.nativeSessionId,
        message: String(error),
      });
    }
  }
  return {
    source: driver.source,
    sessions,
    errors,
    complete: enumerationComplete && errors.length === 0 &&
      sessions.every((session) => session.complete),
  };
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
  const chunks = await Promise.all(
    chunkEvents(events, targetChunkBytes).map(async (chunk) => ({
      ...chunk,
      eventCount: chunk.events.length,
      contentHash: await hashStableArrayValue(chunk.events),
    })),
  );
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
