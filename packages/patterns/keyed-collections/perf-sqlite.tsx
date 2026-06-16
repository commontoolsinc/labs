import {
  cfSqlite,
  computed,
  handler,
  NAME,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  Stream,
  UI,
  type VNode,
} from "commonfabric";
import { type PocTally, type VoteChoice } from "./keyed-collection.ts";

export interface AddOptionEvent {
  id: string;
  title: string;
}

export interface CastVoteEvent {
  voter: string;
  optionId: string;
  choice: VoteChoice;
}

export interface SeedVotesEvent {
  count: number;
}

export interface SqliteTallyRow {
  optionId: string;
  title: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
}

export interface CountRow {
  n: number;
}

export interface PerfSqliteOutput {
  [NAME]: string;
  [UI]: VNode;
  tallies: readonly PocTally[];
  optionCount: number;
  voteCount: number;
  addOption: Stream<AddOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  seedVotes: Stream<SeedVotesEvent>;
}

const addOption = handler<AddOptionEvent, { db: SqliteDb }>(
  ({ id, title }, { db }) => {
    const trimmedId = id.trim();
    const trimmedTitle = title.trim();
    if (!trimmedId || !trimmedTitle) return;
    db.exec(
      "INSERT OR IGNORE INTO options (id, title) VALUES (?, ?)",
      [trimmedId, trimmedTitle],
    );
  },
);

const castVote = handler<CastVoteEvent, { db: SqliteDb }>(
  ({ voter, optionId, choice }, { db }) => {
    const trimmedVoter = voter.trim();
    const trimmedOption = optionId.trim();
    if (!trimmedVoter || !trimmedOption) return;
    db.exec(
      "INSERT OR REPLACE INTO votes (voter, option_id, choice) VALUES (?, ?, ?)",
      [trimmedVoter, trimmedOption, choice],
    );
  },
);

const seedVotes = handler<SeedVotesEvent, { db: SqliteDb }>(
  ({ count }, { db }) => {
    const boundedCount = Math.max(0, Math.floor(count));
    db.exec("DELETE FROM votes");
    for (let i = 0; i < boundedCount; i++) {
      const optionId = ["ethiopia", "colombia", "kenya", "guatemala"][i % 4];
      db.exec(
        "INSERT OR REPLACE INTO votes (voter, option_id, choice) VALUES (?, ?, ?)",
        [`user-${i}`, optionId, "green"],
      );
    }
  },
);

export default pattern<Record<PropertyKey, never>, PerfSqliteOutput>(() => {
  const { table } = cfSqlite;
  const db = sqliteDatabase({
    tables: {
      options: table({
        id: "text primary key",
        title: "text",
      }),
      votes: table({
        voter: "text primary key",
        option_id: "text",
        choice: "text",
      }),
    },
  });

  const tallyQuery = db.query<SqliteTallyRow>(
    "SELECT " +
      "o.id AS optionId, " +
      "o.title AS title, " +
      "SUM(CASE WHEN v.choice = 'red' THEN 1 ELSE 0 END) AS red, " +
      "SUM(CASE WHEN v.choice = 'yellow' THEN 1 ELSE 0 END) AS yellow, " +
      "SUM(CASE WHEN v.choice = 'green' THEN 1 ELSE 0 END) AS green, " +
      "COUNT(v.voter) AS total " +
      "FROM options o LEFT JOIN votes v ON v.option_id = o.id " +
      "GROUP BY o.id, o.title ORDER BY o.id",
    { reactOn: db },
  );
  const optionCountQuery = db.query<CountRow>(
    "SELECT COUNT(*) AS n FROM options",
    { reactOn: db },
  );
  const voteCountQuery = db.query<CountRow>(
    "SELECT COUNT(*) AS n FROM votes",
    { reactOn: db },
  );

  const tallies = computed<PocTally[]>(() => tallyQuery.result ?? []);
  const optionCount = computed(() => optionCountQuery.result?.[0]?.n ?? 0);
  const voteCount = computed(() => voteCountQuery.result?.[0]?.n ?? 0);

  const boundAddOption = addOption({ db });
  const boundCastVote = castVote({ db });
  const boundSeedVotes = seedVotes({ db });

  return {
    [NAME]: "SQLite aggregate perf POC",
    [UI]: <div>SQLite aggregate perf POC</div>,
    tallies,
    optionCount,
    voteCount,
    addOption: boundAddOption,
    castVote: boundCastVote,
    seedVotes: boundSeedVotes,
  };
});
