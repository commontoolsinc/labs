/// <cts-enable />
/**
 * Keyed helper-backed Lunch Poll - diagnostic variant.
 *
 * This keeps the intentionally smaller diagnostic UI from `main-indexed.tsx`,
 * but routes ordered collections and maintained vote tallies through the local
 * `keyed-collection-v1.ts` helper seam. It is not the product lunch poll.
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
import {
  applyLatestByCount,
  type CountBucket,
  countSnapshot,
  encodeKey,
  hasKey,
  type KeyedRecord,
  orderedValues,
  readKey,
  removeLatestByCount,
  removeOrdered,
  upsertOrdered,
  zeroBucket,
} from "../keyed-collections/keyed-collection-v1.ts";

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

type OptionsById = KeyedRecord<Option>;
type UsersByName = KeyedRecord<User>;
type VotesByKey = KeyedRecord<Vote>;
type TallyBucketsByOption = KeyedRecord<CountBucket<VoteColor>>;

const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_USERS_BY_NAME: UsersByName = {};
const EMPTY_VOTES_BY_KEY: VotesByKey = {};
const EMPTY_TALLY_BUCKETS_BY_OPTION: TallyBucketsByOption = {};
const EMPTY_OPTION_ORDER: string[] = [];
const EMPTY_USER_ORDER: string[] = [];
const VOTE_COLORS = ["green", "yellow", "red"] as const;

type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type OptionOrderCell = Writable<
  string[] | Default<typeof EMPTY_OPTION_ORDER>
>;
type UsersByNameCell = Writable<
  UsersByName | Default<typeof EMPTY_USERS_BY_NAME>
>;
type UserOrderCell = Writable<string[] | Default<typeof EMPTY_USER_ORDER>>;
type VotesByKeyCell = Writable<
  VotesByKey | Default<typeof EMPTY_VOTES_BY_KEY>
>;
type TallyBucketsByOptionCell = Writable<
  TallyBucketsByOption | Default<typeof EMPTY_TALLY_BUCKETS_BY_OPTION>
>;
type CountCell = Writable<number | Default<0>>;
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

const userKey = (name: string): string => encodeKey(name);
const optionKey = (optionId: string): string => encodeKey(optionId);
const voteKey = (optionId: string, voterName: string): string =>
  encodeKey(optionId, voterName);

const joinAs = handler<JoinEvent, {
  usersByName: UsersByNameCell;
  userOrder: UserOrderCell;
  userCount: CountCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ name }, { usersByName, userOrder, userCount, myName, adminName }) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  if (trimmedName(myName.get())) return;
  const key = userKey(trimmed);
  if (hasKey(usersByName, key)) return;
  const user: User = {
    name: trimmed,
    avatar: "",
    color: colorForIndex(userOrder.get().length),
    joinedAt: safeDateNow(),
  };
  upsertOrdered(
    { order: userOrder, byId: usersByName, count: userCount },
    key,
    user,
  );
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
  tallyBucketsByOption: TallyBucketsByOptionCell;
  optionCount: CountCell;
  myName: NameCell;
  adminName: NameCell;
}>((
  {
    title,
  },
  {
    optionsById,
    optionOrder,
    tallyBucketsByOption,
    optionCount,
    myName,
    adminName,
  },
) => {
  const me = trimmedName(myName.get());
  if (!me || me !== trimmedName(adminName.get())) return;
  const trimmed = trimmedName(title);
  if (!trimmed) return;
  const id = newOptionId();
  const key = optionKey(id);
  const option: Option = {
    id,
    title: trimmed,
    addedByName: me,
    homePageUrl: "",
    homePageUrlOverride: "",
    imageUrl: "",
  };
  const result = upsertOrdered(
    { order: optionOrder, byId: optionsById, count: optionCount },
    key,
    option,
  );
  if (result === "added") {
    tallyBucketsByOption.key(key).set(countSnapshot(
      tallyBucketsByOption,
      key,
      VOTE_COLORS,
    ));
  }
});

const readOption = (
  optionsById: OptionsByIdCell,
  optionId: string,
): Option | undefined => {
  const key = optionKey(optionId);
  if (!hasKey(optionsById, key)) return undefined;
  const option = readKey(optionsById, key);
  return option?.id === optionId ? option : undefined;
};

const readVote = (
  votesByKey: VotesByKeyCell,
  key: string,
): Vote | undefined => {
  if (!hasKey(votesByKey, key)) return undefined;
  const vote = readKey(votesByKey, key);
  return vote && typeof vote.voterName === "string" ? vote : undefined;
};

const removeTallyBucket = (
  tallyBucketsByOption: TallyBucketsByOptionCell,
  removedKey: string,
): void => {
  const next: TallyBucketsByOption = {};
  for (const [key, bucket] of Object.entries(tallyBucketsByOption.get())) {
    if (key !== removedKey) next[key] = bucket;
  }
  tallyBucketsByOption.set(next);
};

const zeroBucketsForOptions = (
  optionOrder: readonly string[],
): TallyBucketsByOption => {
  const next: TallyBucketsByOption = {};
  for (const key of optionOrder) next[key] = zeroBucket(VOTE_COLORS);
  return next;
};

const removeOption = handler<RemoveOptionEvent, {
  optionsById: OptionsByIdCell;
  optionOrder: OptionOrderCell;
  votesByKey: VotesByKeyCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  optionCount: CountCell;
  voteCount: CountCell;
  myName: NameCell;
  adminName: NameCell;
}>(
  (
    { optionId },
    {
      optionsById,
      optionOrder,
      votesByKey,
      tallyBucketsByOption,
      optionCount,
      voteCount,
      myName,
      adminName,
    },
  ) => {
    const me = trimmedName(myName.get());
    if (!me || me !== trimmedName(adminName.get())) return;
    const trimmedOptionId = optionId.trim();
    if (!trimmedOptionId) return;
    const key = optionKey(trimmedOptionId);
    const removed = removeOrdered(
      { order: optionOrder, byId: optionsById, count: optionCount },
      key,
    );
    if (!removed) return;

    for (const [latestKey, vote] of Object.entries(votesByKey.get())) {
      if (vote.optionId === trimmedOptionId) {
        removeLatestByCount(
          {
            latestByKey: votesByKey,
            countsByGroup: tallyBucketsByOption,
            count: voteCount,
          },
          {
            latestKey,
            group: key,
            choice: vote.voteType,
            choices: VOTE_COLORS,
          },
        );
      }
    }
    removeTallyBucket(tallyBucketsByOption, key);
  },
);

const castVote = handler<CastVoteEvent, {
  optionsById: OptionsByIdCell;
  votesByKey: VotesByKeyCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  voteCount: CountCell;
  myName: NameCell;
}>(({ optionId, voteType }, {
  optionsById,
  votesByKey,
  tallyBucketsByOption,
  voteCount,
  myName,
}) => {
  const me = trimmedName(myName.get());
  const trimmedOptionId = optionId.trim();
  if (!me || !trimmedOptionId) return;
  const option = readOption(optionsById, trimmedOptionId);
  if (!option) return;
  const latestKey = voteKey(option.id, me);
  const previous = readVote(votesByKey, latestKey);
  applyLatestByCount(
    {
      latestByKey: votesByKey,
      countsByGroup: tallyBucketsByOption,
      count: voteCount,
    },
    {
      latestKey,
      item: { voterName: me, optionId: option.id, voteType },
      group: optionKey(option.id),
      choice: voteType,
      previousGroup: previous ? optionKey(previous.optionId) : undefined,
      previousChoice: previous?.voteType,
      choices: VOTE_COLORS,
      removeWhenSame: true,
    },
  );
});

const clearMyVote = handler<ClearVoteEvent, {
  votesByKey: VotesByKeyCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  voteCount: CountCell;
  myName: NameCell;
}>((_, { votesByKey, tallyBucketsByOption, voteCount, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  for (const [latestKey, vote] of Object.entries(votesByKey.get())) {
    if (vote.voterName === me) {
      removeLatestByCount(
        {
          latestByKey: votesByKey,
          countsByGroup: tallyBucketsByOption,
          count: voteCount,
        },
        {
          latestKey,
          group: optionKey(vote.optionId),
          choice: vote.voteType,
          choices: VOTE_COLORS,
        },
      );
    }
  }
});

const resetVotes = handler<ResetVotesEvent, {
  optionOrder: OptionOrderCell;
  votesByKey: VotesByKeyCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  voteCount: CountCell;
  myName: NameCell;
  adminName: NameCell;
}>(
  (
    _,
    {
      optionOrder,
      votesByKey,
      tallyBucketsByOption,
      voteCount,
      myName,
      adminName,
    },
  ) => {
    const me = trimmedName(myName.get());
    if (!me || me !== trimmedName(adminName.get())) return;
    votesByKey.set({});
    tallyBucketsByOption.set(zeroBucketsForOptions(optionOrder.get()));
    voteCount.set(0);
  },
);

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

interface OptionTally {
  option: Option;
  green: number;
  yellow: number;
  red: number;
  voters: Array<{ name: string; voteType: VoteColor; color: string }>;
}

function buildTallies(
  options: readonly Option[],
  tallyBucketsByOption: TallyBucketsByOption,
  votesByKey: VotesByKey,
  usersByName: UsersByName,
): OptionTally[] {
  const tallies = options.map((option): OptionTally => {
    const bucket = tallyBucketsByOption[optionKey(option.id)] ??
      zeroBucket(VOTE_COLORS);
    const voters: Array<{ name: string; voteType: VoteColor; color: string }> =
      [];
    for (const vote of Object.values(votesByKey)) {
      if (vote.optionId === option.id) {
        voters.push({
          name: vote.voterName,
          voteType: vote.voteType,
          color: usersByName[userKey(vote.voterName)]?.color ?? "#888",
        });
      }
    }
    return {
      option,
      green: bucket.choices.green,
      yellow: bucket.choices.yellow,
      red: bucket.choices.red,
      voters,
    };
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

export interface KeyedCozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  city?: PerSpace<string | Default<"Berkeley, CA">>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  optionOrder?: PerSpace<string[] | Default<typeof EMPTY_OPTION_ORDER>>;
  tallyBucketsByOption?: PerSpace<
    TallyBucketsByOption | Default<typeof EMPTY_TALLY_BUCKETS_BY_OPTION>
  >;
  votesByKey?: PerSpace<VotesByKey | Default<typeof EMPTY_VOTES_BY_KEY>>;
  usersByName?: PerSpace<UsersByName | Default<typeof EMPTY_USERS_BY_NAME>>;
  userOrder?: PerSpace<string[] | Default<typeof EMPTY_USER_ORDER>>;
  userCount?: PerSpace<number | Default<0>>;
  optionCount?: PerSpace<number | Default<0>>;
  voteCount?: PerSpace<number | Default<0>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  webSearchUrl?: PerSpace<string | Default<typeof WEB_SEARCH_URL>>;
}

export interface KeyedCozyPollOutput {
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

export default pattern<KeyedCozyPollInput, KeyedCozyPollOutput>(
  ({
    question,
    city,
    optionsById,
    optionOrder,
    tallyBucketsByOption,
    votesByKey,
    usersByName,
    userOrder,
    userCount,
    optionCount,
    voteCount,
    adminName,
    myName,
    webSearchUrl,
  }) => {
    const homePageRefresh = Writable.perSpace.of<number | Default<0>>(0);

    const optionList = computed(() => orderedValues(optionOrder, optionsById));
    const userList = computed(() => orderedValues(userOrder, usersByName));
    const votesSnapshot = computed(() => Object.values(votesByKey));
    const tallies = computed(() =>
      buildTallies(
        optionList,
        tallyBucketsByOption,
        votesByKey,
        usersByName,
      )
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

    const boundJoin = joinAs({
      usersByName,
      userOrder,
      userCount,
      myName,
      adminName,
    });
    const boundClaimHost = claimHost({ myName, adminName });
    const boundAddOption = addOption({
      optionsById,
      optionOrder,
      tallyBucketsByOption,
      optionCount,
      myName,
      adminName,
    });
    const boundRemoveOption = removeOption({
      optionsById,
      optionOrder,
      votesByKey,
      tallyBucketsByOption,
      optionCount,
      voteCount,
      myName,
      adminName,
    });
    const boundCastVote = castVote({
      optionsById,
      votesByKey,
      tallyBucketsByOption,
      voteCount,
      myName,
    });
    const boundClearMyVote = clearMyVote({
      votesByKey,
      tallyBucketsByOption,
      voteCount,
      myName,
    });
    const boundResetVotes = resetVotes({
      optionOrder,
      votesByKey,
      tallyBucketsByOption,
      voteCount,
      myName,
      adminName,
    });
    const boundSetCity = setCity({ city, myName, adminName });
    const boundEnrichHomePages = enrichHomePages({
      myName,
      adminName,
      homePageRefresh,
    });

    return {
      [NAME]: "Keyed helper lunch poll diagnostic",
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
      userCount,
      optionCount,
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
