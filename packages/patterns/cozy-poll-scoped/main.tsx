/**
 * Cozy Lunch Poll - Scoped
 *
 * Collaborative voting with three colors:
 *   🟢 green  (love it)   🟡 yellow (OK)   🔴 red (veto)
 *
 * Winner: fewest reds, then most greens.
 *
 * Identity follows the scrabble idiom:
 * - `users` is a per-space directory of joined participants.
 * - Each viewer's `myName` is per-user; it is set once on join and treated as
 *   immutable thereafter.
 * - The first joiner's name is captured into `adminName` (per-space). They can
 *   add/remove options and reset votes. `isAdmin` is derived, not stored.
 */

import {
  Default,
  derive,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface User {
  name: string;
  color: string;
  joinedAt: number;
}

export interface Option {
  id: string;
  title: string;
  addedByName: string;
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

type QuestionCell = Writable<string | Default<"Where should we eat?">>;
type OptionsCell = Writable<Option[] | Default<[]>>;
type VotesCell = Writable<Vote[] | Default<[]>>;
type UsersCell = Writable<User[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const POLL_THEME = {
  fontFamily:
    "'Avenir Next', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  borderRadius: "8px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#2f6f4e",
    primaryForeground: "#ffffff",
    secondary: "#3b4a6b",
    secondaryForeground: "#ffffff",
    background: "#f1f5ef",
    surface: "#ffffff",
    surfaceHover: "#f6faf4",
    text: "#1d2a1f",
    textMuted: "#5d6f63",
    border: "#cbd9cf",
    borderMuted: "#e2ebe5",
    accent: "#c2573a",
    accentForeground: "#ffffff",
    success: "#2f8a64",
    successForeground: "#ffffff",
    error: "#a33b35",
    errorForeground: "#ffffff",
    warning: "#b27722",
    warningForeground: "#ffffff",
  },
};

const VOTE_SWATCH: Record<VoteColor, string> = {
  green: "#2f8a64",
  yellow: "#d4a82f",
  red: "#a33b35",
};

const trimmedName = (n: string | undefined) => (n ?? "").trim();

const newOptionId = () =>
  `o_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

const colorForIndex = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

const joinAs = handler<JoinEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  joinName: NameCell;
}>(({ name }, { users, myName, adminName, joinName }) => {
  const trimmed = trimmedName(name ?? joinName.get());
  if (!trimmed) return;
  const current = trimmedName(myName.get());
  if (current) return;
  const existing = users.get();
  if (existing.some((u) => u.name === trimmed)) return;
  const user: User = {
    name: trimmed,
    color: colorForIndex(existing.length),
    joinedAt: safeDateNow(),
  };
  users.push(user);
  myName.set(trimmed);
  joinName.set("");
  if (trimmedName(adminName.get()) === "") {
    adminName.set(trimmed);
  }
});

const addOption = handler<AddOptionEvent, {
  options: OptionsCell;
  myName: NameCell;
  adminName: NameCell;
  optionDraft: NameCell;
}>(({ title }, { options, myName, adminName, optionDraft }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const trimmed = trimmedName(title ?? optionDraft.get());
  if (!trimmed) return;
  options.push({
    id: newOptionId(),
    title: trimmed,
    addedByName: me,
  });
  optionDraft.set("");
});

const removeOption = handler<RemoveOptionEvent, {
  options: OptionsCell;
  votes: VotesCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ optionId }, { options, votes, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const current = options.get();
  const target = current.find((o) => o.id === optionId);
  if (!target) return;
  options.remove(target);
  votes.set(votes.get().filter((v) => v.optionId !== optionId));
});

const castVote = handler<CastVoteEvent, {
  votes: VotesCell;
  myName: NameCell;
}>(({ optionId, voteType }, { votes, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  const current = votes.get();
  const existingIdx = current.findIndex(
    (v) => v.voterName === me && v.optionId === optionId,
  );
  if (existingIdx >= 0) {
    const existing = current[existingIdx];
    if (existing.voteType === voteType) {
      votes.remove(existing);
      return;
    }
    votes.key(existingIdx).key("voteType").set(voteType);
    return;
  }
  votes.push({ voterName: me, optionId, voteType });
});

const resetVotes = handler<ResetVotesEvent, {
  votes: VotesCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { votes, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  votes.set([]);
});

interface OptionTally {
  option: Option;
  green: number;
  yellow: number;
  red: number;
  voters: Array<{ name: string; voteType: VoteColor; color: string }>;
}

const tallyOptions = (
  options: readonly Option[],
  votes: readonly Vote[],
  users: readonly User[],
): OptionTally[] => {
  const colorByName = new Map(users.map((u) => [u.name, u.color]));
  const tallies = options.map((option): OptionTally => {
    const optionVotes = votes.filter((v) => v.optionId === option.id);
    return {
      option,
      green: optionVotes.filter((v) => v.voteType === "green").length,
      yellow: optionVotes.filter((v) => v.voteType === "yellow").length,
      red: optionVotes.filter((v) => v.voteType === "red").length,
      voters: optionVotes.map((v) => ({
        name: v.voterName,
        voteType: v.voteType,
        color: colorByName.get(v.voterName) ?? "#888",
      })),
    };
  });
  return [...tallies].sort((a, b) => {
    if (a.red !== b.red) return a.red - b.red;
    return b.green - a.green;
  });
};

const myVoteFor = (
  votes: readonly Vote[],
  me: string,
  optionId: string,
): VoteColor | undefined => {
  if (!me) return undefined;
  return votes.find(
    (v) => v.voterName === me && v.optionId === optionId,
  )?.voteType;
};

export interface CozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  joinName?: PerSession<string | Default<"">>;
  optionDraft?: PerSession<string | Default<"">>;
}

export interface CozyPollOutput {
  [NAME]: string;
  [UI]: VNode;
  question: string;
  options: readonly Option[];
  votes: readonly Vote[];
  users: readonly User[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  isJoined: boolean;
  isAdmin: boolean;
  joinAs: Stream<JoinEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
}

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      options,
      votes,
      users,
      adminName,
      myName,
      joinName,
      optionDraft,
    },
  ) => {
    const boundJoin = joinAs({ users, myName, adminName, joinName });
    const boundAddOption = addOption({
      options,
      myName,
      adminName,
      optionDraft,
    });
    const boundRemoveOption = removeOption({
      options,
      votes,
      myName,
      adminName,
    });
    const boundCastVote = castVote({ votes, myName });
    const boundResetVotes = resetVotes({ votes, myName, adminName });

    const userCount = derive(users, (u) => u.length);
    const optionCount = derive(options, (o) => o.length);
    const voteCount = derive(votes, (v) => v.length);
    const isJoined = derive(myName, (n) => trimmedName(n) !== "");
    const isAdmin = derive(
      { myName, adminName },
      ({ myName, adminName }) =>
        trimmedName(myName) !== "" &&
        trimmedName(myName) === trimmedName(adminName),
    );
    const ranked = derive(
      { options, votes, users },
      ({ options, votes, users }) => tallyOptions(options, votes, users),
    );

    return {
      [NAME]: "Cozy lunch poll",
      [UI]: (
        <cf-theme theme={POLL_THEME}>
          <cf-screen>
            <cf-vstack slot="header" gap="2" padding="4">
              <cf-heading level={2}>
                {question}
              </cf-heading>
              <div style={{ color: "var(--cf-theme-color-text-muted)" }}>
                {userCount} joined · {optionCount} options · {voteCount} votes
                {isAdmin ? " · you are admin" : ""}
              </div>
            </cf-vstack>

            <cf-vscroll flex showScrollbar fadeEdges>
              <cf-vstack gap="3" padding="4">
                {isJoined
                  ? (
                    <cf-card>
                      <div slot="content">
                        Signed in as <strong>{myName}</strong>
                      </div>
                    </cf-card>
                  )
                  : (
                    <cf-card>
                      <cf-vstack slot="content" gap="2">
                        <cf-label>Join the poll</cf-label>
                        <cf-hstack gap="2">
                          <cf-input
                            $value={joinName}
                            placeholder="Your name"
                            aria-label="Your name"
                            timing-strategy="immediate"
                          />
                          <cf-button onClick={boundJoin}>
                            Join
                          </cf-button>
                        </cf-hstack>
                      </cf-vstack>
                    </cf-card>
                  )}

                {isAdmin
                  ? (
                    <cf-card>
                      <cf-vstack slot="content" gap="2">
                        <cf-label>Add an option (admin)</cf-label>
                        <cf-hstack gap="2">
                          <cf-input
                            $value={optionDraft}
                            placeholder="e.g. Sushi place"
                            aria-label="Option title"
                            timing-strategy="immediate"
                          />
                          <cf-button onClick={boundAddOption}>
                            Add
                          </cf-button>
                          <cf-button onClick={boundResetVotes}>
                            Reset votes
                          </cf-button>
                        </cf-hstack>
                      </cf-vstack>
                    </cf-card>
                  )
                  : null}

                <cf-vstack gap="2">
                  {ranked.map((tally) => {
                    const myVote = derive(
                      { votes, myName, optionId: tally.option.id },
                      ({ votes, myName, optionId }) =>
                        myVoteFor(votes, trimmedName(myName), optionId),
                    );
                    return (
                      <cf-card>
                        <cf-vstack slot="content" gap="2">
                          <cf-hstack justify="between" align="center">
                            <cf-heading level={4}>
                              {tally.option.title}
                            </cf-heading>
                            <div
                              style={{
                                color: "var(--cf-theme-color-text-muted)",
                                fontSize: "13px",
                              }}
                            >
                              🟢 {tally.green} · 🟡 {tally.yellow} · 🔴{" "}
                              {tally.red}
                            </div>
                          </cf-hstack>
                          <cf-hstack gap="1" wrap>
                            {tally.voters.map((v) => (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  padding: "2px 8px",
                                  borderRadius: "12px",
                                  background: VOTE_SWATCH[v.voteType],
                                  color: "white",
                                  fontSize: "12px",
                                  borderLeft: `4px solid ${v.color}`,
                                }}
                              >
                                {v.name}
                              </span>
                            ))}
                          </cf-hstack>
                          {isJoined
                            ? (
                              <cf-hstack gap="2">
                                <cf-button
                                  onClick={() =>
                                    boundCastVote.send({
                                      optionId: tally.option.id,
                                      voteType: "green",
                                    })}
                                >
                                  {myVote === "green" ? "✓ " : ""}🟢 Love it
                                </cf-button>
                                <cf-button
                                  onClick={() =>
                                    boundCastVote.send({
                                      optionId: tally.option.id,
                                      voteType: "yellow",
                                    })}
                                >
                                  {myVote === "yellow" ? "✓ " : ""}🟡 OK
                                </cf-button>
                                <cf-button
                                  onClick={() =>
                                    boundCastVote.send({
                                      optionId: tally.option.id,
                                      voteType: "red",
                                    })}
                                >
                                  {myVote === "red" ? "✓ " : ""}🔴 Veto
                                </cf-button>
                                {isAdmin
                                  ? (
                                    <cf-button
                                      onClick={() =>
                                        boundRemoveOption.send({
                                          optionId: tally.option.id,
                                        })}
                                    >
                                      Remove
                                    </cf-button>
                                  )
                                  : null}
                              </cf-hstack>
                            )
                            : null}
                        </cf-vstack>
                      </cf-card>
                    );
                  })}
                </cf-vstack>
              </cf-vstack>
            </cf-vscroll>
          </cf-screen>
        </cf-theme>
      ),
      question: derive(question, (q) => q),
      options: derive(options, (o) => o),
      votes: derive(votes, (v) => v),
      users: derive(users, (u) => u),
      adminName: derive(adminName, (a) => a),
      myName: derive(myName, (n) => n),
      userCount,
      optionCount,
      voteCount,
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      resetVotes: boundResetVotes,
    };
  },
);
