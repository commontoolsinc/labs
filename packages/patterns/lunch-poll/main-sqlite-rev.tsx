/// <cts-enable />
/**
 * SQLite Lunch Poll - diagnostic variant.
 *
 * Same harness contract as `main-indexed.tsx`, but the *vote* state is stored in
 * a SQLite table (one row per (voter, option) via `db.exec` INSERT OR REPLACE)
 * instead of a shared `votesByOption` cell. Options/users stay as indexed cells
 * — so this isolates ONE variable: the vote-write mechanism.
 *
 * Hypothesis under test (from the Phase-1 diagnostics): the array AND indexed
 * variants both read-modify-write a shared `votes` cell, so they show identical
 * concurrent ConflictError retries. Per-row SQLite inserts touch distinct rows
 * with no shared mutable cell and `reactOn: db` (no rev-counter), so concurrent
 * voters should contend less. `voteCount`/votes are surfaced via single query
 * nodes, so the reactive graph should also stay flat in vote count.
 */

import {
  cfSqlite,
  computed,
  Default,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  type SqliteDb,
  sqliteDatabase,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const WEB_SEARCH_URL = "/api/agent-tools/web-search";

export interface User {
  name: string;
  avatar?: string;
  color: string;
  joinedAt: number;
}

export interface Option {
  id: string;
  title: string;
  addedByName: string;
  homePageUrl?: string;
  homePageUrlOverride?: string;
  imageUrl?: string;
}

export type VoteColor = "green" | "yellow" | "red";

export interface Vote {
  voterName: string;
  optionId: string;
  voteType: VoteColor;
}

export interface JoinEvent {
  name?: string;
}

export type ClaimHostEvent = Record<PropertyKey, never>;

export interface AddOptionEvent {
  title?: string;
}

export interface RemoveOptionEvent {
  optionId: string;
}

export interface CastVoteEvent {
  optionId: string;
  voteType: VoteColor;
}

export type ResetVotesEvent = Record<PropertyKey, never>;
export type ClearVoteEvent = Record<PropertyKey, never>;
export type EnrichHomePagesEvent = Record<PropertyKey, never>;

export interface SetCityEvent {
  city?: string;
}

export interface SetOptionUrlEvent {
  optionId: string;
  url?: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  loggedByName: string;
  wentAt: number;
}

export interface LogVisitEvent {
  optionId?: string;
  title?: string;
  wentAt?: number;
}

export interface RemoveHistoryEntryEvent {
  id: string;
}

export type ClearHistoryEvent = Record<PropertyKey, never>;

interface VoteRow {
  voterName: string;
  optionId: string;
  voteType: VoteColor;
}

interface CountRow {
  n: number;
}

type OptionsById = Record<string, Option>;
type UsersByName = Record<string, User>;

const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_USERS_BY_NAME: UsersByName = {};

type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type OptionOrderCell = Writable<string[] | Default<[]>>;
type UsersByNameCell = Writable<
  UsersByName | Default<typeof EMPTY_USERS_BY_NAME>
>;
type UserOrderCell = Writable<string[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;
type CityCell = Writable<string | Default<"Berkeley, CA">>;
type RefreshCell = Writable<number | Default<0>>;
type RevCell = Writable<number | Default<0>>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const EMPTY_OPTIONS: Option[] = [];
const EMPTY_VOTES: Vote[] = [];
const EMPTY_USERS: User[] = [];
const EMPTY_HISTORY: HistoryEntry[] = [];

const trimmedName = (n: string | undefined) => (n ?? "").trim();

const colorForIndex = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];

const newOptionId = (): string =>
  `o_${Math.floor(safeDateNow()).toString(36)}_${
    Math.floor(nonPrivateRandom() * 1_000_000).toString(36)
  }`;

const voteKey = (voter: string, optionId: string): string =>
  `${voter}::${optionId}`;

const isOption = (value: Option | undefined): value is Option =>
  value !== undefined;

const isUser = (value: User | undefined): value is User => value !== undefined;

const joinAs = handler<JoinEvent, {
  usersByName: UsersByNameCell;
  userOrder: UserOrderCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ name }, { usersByName, userOrder, myName, adminName }) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  if (trimmedName(myName.get())) return;
  const users = usersByName.get() ?? {};
  if (users[trimmed]) return;
  const order = userOrder.get() ?? [];
  usersByName.key(trimmed).set({
    name: trimmed,
    avatar: "",
    color: colorForIndex(order.length),
    joinedAt: safeDateNow(),
  });
  userOrder.push(trimmed);
  myName.set(trimmed);
  if (!trimmedName(adminName.get())) adminName.set(trimmed);
});

const claimHost = handler<ClaimHostEvent, {
  myName: NameCell;
  adminName: NameCell;
}>((_, { myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me || trimmedName(adminName.get()) === me) return;
  adminName.set(me);
});

const addOption = handler<AddOptionEvent, {
  optionsById: OptionsByIdCell;
  optionOrder: OptionOrderCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ title }, { optionsById, optionOrder, myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  const trimmed = trimmedName(title);
  if (!trimmed) return;
  const id = newOptionId();
  optionsById.key(id).set({
    id,
    title: trimmed,
    addedByName: me,
    homePageUrl: "",
    homePageUrlOverride: "",
    imageUrl: "",
  });
  optionOrder.push(id);
});

const removeOption = handler<RemoveOptionEvent, {
  optionsById: OptionsByIdCell;
  optionOrder: OptionOrderCell;
  db: SqliteDb;
  myName: NameCell;
  adminName: NameCell;
}>(
  (
    { optionId },
    { optionsById, optionOrder, db, myName, adminName },
  ) => {
    const me = trimmedName(myName.get());
    if (!me || me !== trimmedName(adminName.get())) return;
    const currentOptions = optionsById.get() ?? {};
    if (!currentOptions[optionId]) return;

    const nextOptions: OptionsById = {};
    for (const [id, option] of Object.entries(currentOptions)) {
      if (id !== optionId) nextOptions[id] = option;
    }
    optionsById.set(nextOptions);
    optionOrder.set((optionOrder.get() ?? []).filter((id) => id !== optionId));
    db.exec("DELETE FROM votes WHERE option_id = ?", [optionId]);
  },
);

// Vote write: a single per-(voter,option) row, INSERT OR REPLACE. No shared
// votes cell, no rev-counter — the queries below `reactOn: db`.
const castVote = handler<CastVoteEvent, {
  db: SqliteDb;
  myName: NameCell;
  rev: RevCell;
}>(({ optionId, voteType }, { db, myName, rev }) => {
  const me = trimmedName(myName.get());
  if (!me || !optionId) return;
  db.exec(
    "INSERT OR REPLACE INTO votes (id, voter, option_id, vote_type) " +
      "VALUES (?, ?, ?, ?)",
    [voteKey(me, optionId), me, optionId, voteType],
  );
  // Bump the shared rev counter so the queries (reactOn: sqliteRev) re-run.
  // NOTE: this is the read-modify-write of a shared cell we expect to
  // reintroduce concurrent-write contention.
  rev.set((rev.get() ?? 0) + 1);
});

const clearMyVote = handler<ClearVoteEvent, {
  db: SqliteDb;
  myName: NameCell;
}>((_, { db, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  db.exec("DELETE FROM votes WHERE voter = ?", [me]);
});

const resetVotes = handler<ResetVotesEvent, {
  db: SqliteDb;
  myName: NameCell;
  adminName: NameCell;
}>((_, { db, myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  db.exec("DELETE FROM votes");
});

const setCity = handler<SetCityEvent, {
  city: CityCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ city: nextCity }, { city, myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  const next = trimmedName(nextCity);
  if (next) city.set(next);
});

const enrichHomePages = handler<EnrichHomePagesEvent, {
  myName: NameCell;
  adminName: NameCell;
  homePageRefresh: RefreshCell;
}>((_, { myName, adminName, homePageRefresh }) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  homePageRefresh.set(Number(homePageRefresh.get() ?? 0) + 1);
});

const noopOptionUrl = handler<
  SetOptionUrlEvent,
  { homePageRefresh: RefreshCell }
>(() => {});
const noopLogVisit = handler<LogVisitEvent, { homePageRefresh: RefreshCell }>(
  () => {},
);
const noopRemoveHistory = handler<
  RemoveHistoryEntryEvent,
  { homePageRefresh: RefreshCell }
>(() => {});
const noopClearHistory = handler<
  ClearHistoryEvent,
  { homePageRefresh: RefreshCell }
>(() => {});

export interface SqliteCozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  city?: PerSpace<string | Default<"Berkeley, CA">>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  optionOrder?: PerSpace<string[] | Default<[]>>;
  usersByName?: PerSpace<UsersByName | Default<typeof EMPTY_USERS_BY_NAME>>;
  userOrder?: PerSpace<string[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  webSearchUrl?: PerSpace<string | Default<typeof WEB_SEARCH_URL>>;
}

export interface SqliteCozyPollOutput {
  [NAME]: string;
  [UI]: VNode;
  question: string;
  city: string;
  options: readonly Option[];
  votes: readonly Vote[];
  users: readonly User[];
  history: readonly HistoryEntry[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  historyCount: number;
  isJoined: boolean;
  isAdmin: boolean;
  homePageLookupUrls: readonly string[];
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVote: Stream<ClearVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
  logVisit: Stream<LogVisitEvent>;
  removeHistoryEntry: Stream<RemoveHistoryEntryEvent>;
  clearHistory: Stream<ClearHistoryEvent>;
  setCity: Stream<SetCityEvent>;
  enrichHomePages: Stream<EnrichHomePagesEvent>;
  setOptionUrl: Stream<SetOptionUrlEvent>;
}

export default pattern<SqliteCozyPollInput, SqliteCozyPollOutput>(
  ({
    question,
    city,
    optionsById,
    optionOrder,
    usersByName,
    userOrder,
    adminName,
    myName,
    webSearchUrl,
  }) => {
    const { table } = cfSqlite;
    const db = sqliteDatabase({
      tables: {
        votes: table({
          id: "text primary key",
          voter: "text",
          option_id: "text",
          vote_type: "text",
        }),
      },
    });

    const homePageRefresh = Writable.perSpace.of<number | Default<0>>(0);
    const sqliteRev = Writable.perSpace.of<number | Default<0>>(0);

    const optionList = computed(() =>
      (optionOrder ?? [])
        .map((id) => optionsById?.[id])
        .filter(isOption)
    );
    const userList = computed(() =>
      (userOrder ?? [])
        .map((name) => usersByName?.[name])
        .filter(isUser)
    );

    // Votes + count come from single query nodes (flat in vote count).
    const votesQuery = db.query<VoteRow>(
      "SELECT voter AS voterName, option_id AS optionId, " +
        "vote_type AS voteType FROM votes",
      { reactOn: sqliteRev },
    );
    const voteCountQuery = db.query<CountRow>(
      "SELECT COUNT(*) AS n FROM votes",
      { reactOn: sqliteRev },
    );
    const votesSnapshot = computed<Vote[]>(() => votesQuery.result ?? []);
    const voteCount = computed(() => voteCountQuery.result?.[0]?.n ?? 0);

    const me = trimmedName(myName);
    const admin = trimmedName(adminName);
    const isJoined = me !== "";
    const isAdmin = me !== "" && me === admin;
    const searchEndpoint = trimmedName(webSearchUrl) || WEB_SEARCH_URL;
    const homePageLookupUrls = computed(() =>
      optionList.map(() => isAdmin ? searchEndpoint : "")
    );

    const boundJoin = joinAs({ usersByName, userOrder, myName, adminName });
    const boundClaimHost = claimHost({ myName, adminName });
    const boundAddOption = addOption({
      optionsById,
      optionOrder,
      myName,
      adminName,
    });
    const boundRemoveOption = removeOption({
      optionsById,
      optionOrder,
      db,
      myName,
      adminName,
    });
    const boundCastVote = castVote({ db, myName, rev: sqliteRev });
    const boundClearMyVote = clearMyVote({ db, myName });
    const boundResetVotes = resetVotes({ db, myName, adminName });
    const boundSetCity = setCity({ city, myName, adminName });
    const boundEnrichHomePages = enrichHomePages({
      myName,
      adminName,
      homePageRefresh,
    });

    return {
      [NAME]: "SQLite lunch poll diagnostic",
      [UI]: (
        <div>
          <h2>{question}</h2>
          <p>
            Host: {admin || "none"} · Me: {me || "not joined"} · City: {city}
          </p>
          <p>
            {userList.length} users · {optionList.length} options ·{" "}
            {voteCount} votes
          </p>
        </div>
      ),
      question,
      city,
      options: computed(() => optionList ?? EMPTY_OPTIONS),
      votes: computed(() => votesSnapshot ?? EMPTY_VOTES),
      users: computed(() => userList ?? EMPTY_USERS),
      history: computed(() => EMPTY_HISTORY),
      adminName: computed(() => trimmedName(adminName)),
      myName: computed(() => trimmedName(myName)),
      userCount: userList.length,
      optionCount: optionList.length,
      voteCount,
      historyCount: 0,
      isJoined,
      isAdmin,
      homePageLookupUrls,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
      logVisit: noopLogVisit({ homePageRefresh }),
      removeHistoryEntry: noopRemoveHistory({ homePageRefresh }),
      clearHistory: noopClearHistory({ homePageRefresh }),
      setCity: boundSetCity,
      enrichHomePages: boundEnrichHomePages,
      setOptionUrl: noopOptionUrl({ homePageRefresh }),
    };
  },
);
