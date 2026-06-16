/// <cts-enable />
/**
 * Indexed Lunch Poll - diagnostic variant.
 *
 * This file intentionally keeps a smaller UI than `main.tsx` while preserving
 * the core poll contract used by the headless diagnostics. Its purpose is to
 * compare authoring complexity and graph shape when the pattern author stores
 * collaboration state in keyed structures instead of flat shared arrays.
 */

import {
  computed,
  Default,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
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

type OptionsById = Record<string, Option>;
type UsersByName = Record<string, User>;
type VotesByOption = Record<string, Record<string, VoteColor>>;

const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_USERS_BY_NAME: UsersByName = {};
const EMPTY_VOTES_BY_OPTION: VotesByOption = {};

type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type OptionOrderCell = Writable<string[] | Default<[]>>;
type UsersByNameCell = Writable<
  UsersByName | Default<typeof EMPTY_USERS_BY_NAME>
>;
type UserOrderCell = Writable<string[] | Default<[]>>;
type VotesByOptionCell = Writable<
  VotesByOption | Default<typeof EMPTY_VOTES_BY_OPTION>
>;
type NameCell = Writable<string | Default<"">>;
type CityCell = Writable<string | Default<"Berkeley, CA">>;
type RefreshCell = Writable<number | Default<0>>;

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
  votesByOption: VotesByOptionCell;
  myName: NameCell;
  adminName: NameCell;
}>(
  (
    { optionId },
    { optionsById, optionOrder, votesByOption, myName, adminName },
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

    const nextVotes: VotesByOption = {};
    for (const [id, bucket] of Object.entries(votesByOption.get() ?? {})) {
      if (id !== optionId) nextVotes[id] = bucket;
    }
    votesByOption.set(nextVotes);
  },
);

const castVote = handler<CastVoteEvent, {
  votesByOption: VotesByOptionCell;
  myName: NameCell;
}>(({ optionId, voteType }, { votesByOption, myName }) => {
  const me = trimmedName(myName.get());
  if (!me || !optionId) return;
  const bucket = votesByOption.get()?.[optionId] ?? {};
  if (bucket[me] === voteType) {
    const nextBucket: Record<string, VoteColor> = {};
    for (const [name, color] of Object.entries(bucket)) {
      if (name !== me) nextBucket[name] = color;
    }
    votesByOption.key(optionId).set(nextBucket);
    return;
  }
  votesByOption.key(optionId).key(me).set(voteType);
});

const clearMyVote = handler<ClearVoteEvent, {
  votesByOption: VotesByOptionCell;
  myName: NameCell;
}>((_, { votesByOption, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  const nextVotes: VotesByOption = {};
  for (const [optionId, bucket] of Object.entries(votesByOption.get() ?? {})) {
    const nextBucket: Record<string, VoteColor> = {};
    for (const [name, color] of Object.entries(bucket)) {
      if (name !== me) nextBucket[name] = color;
    }
    nextVotes[optionId] = nextBucket;
  }
  votesByOption.set(nextVotes);
});

const resetVotes = handler<ResetVotesEvent, {
  votesByOption: VotesByOptionCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { votesByOption, myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  votesByOption.set({});
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
>(
  () => {},
);
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
>(
  () => {},
);

interface OptionTally {
  option: Option;
  green: number;
  yellow: number;
  red: number;
  voters: Array<{ name: string; voteType: VoteColor; color: string }>;
}

function buildVotesSnapshot(votesByOption: VotesByOption): Vote[] {
  const votes: Vote[] = [];
  for (const [optionId, bucket] of Object.entries(votesByOption)) {
    for (const [voterName, voteType] of Object.entries(bucket)) {
      votes.push({ voterName, optionId, voteType });
    }
  }
  return votes;
}

function buildTallies(
  options: readonly Option[],
  votesByOption: VotesByOption,
  usersByName: UsersByName,
): OptionTally[] {
  const tallies = options.map((option): OptionTally => {
    const bucket = votesByOption[option.id] ?? {};
    let green = 0;
    let yellow = 0;
    let red = 0;
    const voters: Array<{ name: string; voteType: VoteColor; color: string }> =
      [];
    for (const [name, voteType] of Object.entries(bucket)) {
      if (voteType === "green") green++;
      if (voteType === "yellow") yellow++;
      if (voteType === "red") red++;
      voters.push({
        name,
        voteType,
        color: usersByName[name]?.color ?? "#888",
      });
    }
    return { option, green, yellow, red, voters };
  });
  return tallies.sort((a, b) => {
    if (a.red !== b.red) return a.red - b.red;
    return b.green - a.green;
  });
}

function buildRankByOptionId(
  tallies: readonly OptionTally[],
): Record<string, number> {
  const ranks: Record<string, number> = {};
  for (let index = 0; index < tallies.length; index++) {
    ranks[tallies[index]!.option.id] = index + 1;
  }
  return ranks;
}

export interface IndexedCozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  city?: PerSpace<string | Default<"Berkeley, CA">>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  optionOrder?: PerSpace<string[] | Default<[]>>;
  votesByOption?: PerSpace<
    VotesByOption | Default<typeof EMPTY_VOTES_BY_OPTION>
  >;
  usersByName?: PerSpace<UsersByName | Default<typeof EMPTY_USERS_BY_NAME>>;
  userOrder?: PerSpace<string[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  webSearchUrl?: PerSpace<string | Default<typeof WEB_SEARCH_URL>>;
}

export interface IndexedCozyPollOutput {
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

export default pattern<IndexedCozyPollInput, IndexedCozyPollOutput>(
  ({
    question,
    city,
    optionsById,
    optionOrder,
    votesByOption,
    usersByName,
    userOrder,
    adminName,
    myName,
    webSearchUrl,
  }) => {
    const homePageRefresh = Writable.perSpace.of<number | Default<0>>(0);

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
    const votesSnapshot = computed(() =>
      buildVotesSnapshot(votesByOption ?? {})
    );
    const tallies = computed(() =>
      buildTallies(optionList, votesByOption ?? {}, usersByName ?? {})
    );
    const rankByOptionId = computed(() => buildRankByOptionId(tallies));

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
      votesByOption,
      myName,
      adminName,
    });
    const boundCastVote = castVote({ votesByOption, myName });
    const boundClearMyVote = clearMyVote({ votesByOption, myName });
    const boundResetVotes = resetVotes({ votesByOption, myName, adminName });
    const boundSetCity = setCity({ city, myName, adminName });
    const boundEnrichHomePages = enrichHomePages({
      myName,
      adminName,
      homePageRefresh,
    });

    return {
      [NAME]: "Indexed lunch poll diagnostic",
      [UI]: (
        <div>
          <h2>{question}</h2>
          <p>
            Host: {admin || "none"} · Me: {me || "not joined"} · City: {city}
          </p>
          <p>
            {userList.length} users · {optionList.length} options ·{" "}
            {votesSnapshot.length} votes
          </p>
          <div>
            {optionList.map((option) => {
              const tally = tallies.find((entry) =>
                entry.option.id === option.id
              );
              const rank = rankByOptionId[option.id] ?? 0;
              return (
                <div>
                  <strong>#{rank} {option.title}</strong>
                  <span>
                    Green {tally?.green ?? 0} · Yellow {tally?.yellow ?? 0}{" "}
                    · Red {tally?.red ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
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
      voteCount: votesSnapshot.length,
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
