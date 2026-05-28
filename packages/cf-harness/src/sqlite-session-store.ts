import { Database } from "@db/sqlite";
import {
  type HarnessChatEventEnvelope,
  type HarnessChatSessionStatus,
} from "./contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type {
  HarnessChatEventListOptions,
  HarnessChatSessionSnapshot,
  HarnessChatSessionStore,
} from "./session-store.ts";

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`;

const INIT = `
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS chat_session (
  session_id  TEXT NOT NULL PRIMARY KEY,
  status      TEXT NOT NULL,
  transcript  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_session_updated_at
  ON chat_session (updated_at);

CREATE TABLE IF NOT EXISTS chat_event (
  sequence    INTEGER NOT NULL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  turn_id     TEXT,
  kind        TEXT NOT NULL,
  emitted_at  TEXT NOT NULL,
  event       TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_session(session_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_event_session_sequence
  ON chat_event (session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_chat_event_emitted_at
  ON chat_event (emitted_at);

COMMIT;
`;

type SessionRow = {
  status: string;
  transcript: string;
};

type EventRow = {
  event: string;
};

export interface OpenSqliteHarnessChatSessionStoreOptions {
  url: URL;
}

const databaseAddress = (url: URL): URL | string =>
  url.protocol === "file:" ? url : ":memory:";

const parseJsonColumn = <Value>(
  value: string,
  column: string,
): Value => {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new Error(
      `failed to parse ${column}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export class SqliteHarnessChatSessionStore implements HarnessChatSessionStore {
  readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  saveSession(snapshot: HarnessChatSessionSnapshot): void {
    this.database.prepare(`
      INSERT INTO chat_session (
        session_id,
        status,
        transcript,
        created_at,
        updated_at,
        closed_at
      )
      VALUES (
        :session_id,
        :status,
        :transcript,
        :created_at,
        :updated_at,
        :closed_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        status = :status,
        transcript = :transcript,
        updated_at = :updated_at,
        closed_at = :closed_at
    `).run({
      session_id: snapshot.session.sessionId,
      status: JSON.stringify(snapshot.session),
      transcript: JSON.stringify(snapshot.transcript),
      created_at: snapshot.session.createdAt,
      updated_at: snapshot.session.updatedAt,
      closed_at: snapshot.session.closedAt ?? null,
    });
  }

  getSession(
    sessionId: string,
  ): HarnessChatSessionSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT status, transcript
      FROM chat_session
      WHERE session_id = :session_id
    `).get({ session_id: sessionId }) as SessionRow | undefined;
    return row === undefined ? undefined : decodeSessionRow(row);
  }

  listSessions(): readonly HarnessChatSessionSnapshot[] {
    return (this.database.prepare(`
      SELECT status, transcript
      FROM chat_session
      ORDER BY created_at ASC, session_id ASC
    `).all() as SessionRow[]).map(decodeSessionRow);
  }

  saveSessionAndAppendEvent(
    snapshot: HarnessChatSessionSnapshot,
    event: HarnessChatEventEnvelope,
  ): void {
    this.database.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      this.saveSession(snapshot);
      this.appendEvent(event);
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  appendEvent(event: HarnessChatEventEnvelope): void {
    this.database.prepare(`
      INSERT INTO chat_event (
        sequence,
        session_id,
        turn_id,
        kind,
        emitted_at,
        event
      )
      VALUES (
        :sequence,
        :session_id,
        :turn_id,
        :kind,
        :emitted_at,
        :event
      )
    `).run({
      sequence: event.sequence,
      session_id: event.sessionId,
      turn_id: event.turnId ?? null,
      kind: event.event.kind,
      emitted_at: event.emittedAt,
      event: JSON.stringify(event),
    });
  }

  listEvents(
    options: HarnessChatEventListOptions = {},
  ): readonly HarnessChatEventEnvelope[] {
    const clauses: string[] = [];
    const params: Record<string, number | string> = {};
    if (options.sessionId !== undefined) {
      clauses.push("session_id = :session_id");
      params.session_id = options.sessionId;
    }
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > :after_sequence");
      params.after_sequence = options.afterSequence;
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const limit = options.limit === undefined ? "" : "LIMIT :limit";
    if (options.limit !== undefined) {
      params.limit = options.limit;
    }
    return (this.database.prepare(`
      SELECT event
      FROM chat_event
      ${where}
      ORDER BY sequence ASC
      ${limit}
    `).all(params) as EventRow[]).map((row) =>
      parseJsonColumn<HarnessChatEventEnvelope>(row.event, "chat_event.event")
    );
  }

  latestSequence(): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM chat_event
    `).get() as { sequence: number };
    return row.sequence;
  }

  close(): void {
    this.database.close();
  }
}

const decodeSessionRow = (row: SessionRow): HarnessChatSessionSnapshot => ({
  session: parseJsonColumn<HarnessChatSessionStatus>(
    row.status,
    "chat_session.status",
  ),
  transcript: parseJsonColumn<HarnessTranscriptMessage[]>(
    row.transcript,
    "chat_session.transcript",
  ),
});

export const openSqliteHarnessChatSessionStore = async (
  options: OpenSqliteHarnessChatSessionStoreOptions,
): Promise<SqliteHarnessChatSessionStore> => {
  const database = await new Database(databaseAddress(options.url), {
    create: true,
  });
  database.exec(PRAGMAS);
  database.exec(INIT);
  return new SqliteHarnessChatSessionStore(database);
};
