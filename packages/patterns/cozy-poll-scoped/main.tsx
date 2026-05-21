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
  computed,
  Default,
  derive,
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

const getInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(
    0,
    2,
  );
};

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

export interface ClearVoteEvent {
  optionId: string;
}

const clearMyVote = handler<ClearVoteEvent, {
  votes: VotesCell;
  myName: NameCell;
}>(({ optionId }, { votes, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  votes.set(
    votes.get().filter(
      (v) => !(v.voterName === me && v.optionId === optionId),
    ),
  );
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
  // joinName + optionDraft are internal form drafts, declared as local
  // per-session cells in the pattern body (parking-coordinator idiom).
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
  clearMyVote: Stream<ClearVoteEvent>;
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
    },
  ) => {
    // Internal per-session form drafts — local to each browser session,
    // not exposed as pattern inputs. Uses the scoped-constructor idiom
    // introduced by parking-coordinator (PR #3610).
    const joinName = Writable.perSession.of<string>("");
    const optionDraft = Writable.perSession.of<string>("");

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
    const boundClearMyVote = clearMyVote({ votes, myName });
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

    const topChoice = derive(
      { ranked, voteCount },
      ({ ranked, voteCount }) =>
        voteCount > 0 && ranked.length > 0 ? ranked[0] : null,
    );

    return {
      [NAME]: "Cozy lunch poll",
      [UI]: (
        <cf-theme theme={POLL_THEME}>
          <cf-screen>
            {/* Header */}
            <div
              slot="header"
              style={{
                padding: "16px 20px 12px",
                borderBottom: "1px solid #e5e7eb",
                background: "white",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "12px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    {question}
                  </h2>
                  {computed(() => {
                    const u = userCount ?? 0;
                    const o = optionCount ?? 0;
                    const v = voteCount ?? 0;
                    const admin = trimmedName(adminName);
                    const me = trimmedName(myName);
                    const amAdmin = me !== "" && me === admin;
                    // "you are the host" is handled by the HOST chip in the
                    // top right; only call out the host's name to non-admins.
                    const hostNote = !amAdmin && me !== "" && admin !== ""
                      ? ` · hosted by ${admin}`
                      : "";
                    return (
                      <div
                        style={{
                          marginTop: "4px",
                          fontSize: "13px",
                          color: "#6b7280",
                        }}
                      >
                        {u} joined · {o} options · {v} votes{hostNote}
                      </div>
                    );
                  })}
                </div>
                {computed(() => {
                  const me = trimmedName(myName);
                  if (me === "") return null;
                  const admin = trimmedName(adminName);
                  const amAdmin = me !== "" && me === admin;
                  return (
                    <div
                      style={{
                        display: "flex",
                        gap: "6px",
                        alignItems: "center",
                      }}
                    >
                      {amAdmin
                        ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              padding: "4px 10px",
                              borderRadius: "9999px",
                              background: "#dbeafe",
                              border: "1px solid #93c5fd",
                              fontSize: "11px",
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              color: "#1e40af",
                              whiteSpace: "nowrap",
                            }}
                          >
                            HOST
                          </span>
                        )
                        : null}
                      <span
                        title={me}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "4px 10px",
                          borderRadius: "9999px",
                          background: "#f3f4f6",
                          border: "1px solid #e5e7eb",
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#374151",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ fontSize: "10px", color: "#10b981" }}>
                          ●
                        </span>
                        {me}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <cf-vscroll flex showScrollbar fadeEdges>
              <div
                style={{
                  padding: "16px 20px",
                  maxWidth: "720px",
                  margin: "0 auto",
                }}
              >
                {/* Join card — hidden after the viewer joins. */}
                {isJoined ? null : (
                  <div
                    style={{
                      padding: "16px",
                      marginBottom: "16px",
                      border: "1px solid #fde68a",
                      backgroundColor: "#fef3c7",
                      borderRadius: "8px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        color: "#92400e",
                        marginBottom: "8px",
                      }}
                    >
                      Join the poll
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                      }}
                    >
                      <cf-input
                        $value={joinName}
                        placeholder="Your name"
                        aria-label="Your name"
                        timing-strategy="immediate"
                        style="flex:1"
                      />
                      <cf-button onClick={boundJoin}>Join</cf-button>
                    </div>
                  </div>
                )}

                {/* Top choice — only when there are votes */}
                {computed(() => {
                  const tally = topChoice;
                  if (!tally) return null;
                  const parts: string[] = [];
                  if (tally.green > 0) parts.push(`${tally.green} love it`);
                  if (tally.yellow > 0) {
                    parts.push(`${tally.yellow} okay with it`);
                  }
                  if (tally.red > 0) parts.push(`${tally.red} can't accept`);
                  const summary = parts.join(", ");
                  const hasReds = tally.red > 0;
                  return (
                    <div
                      style={{
                        padding: "16px",
                        marginBottom: "16px",
                        border: "2px solid #10b981",
                        borderRadius: "8px",
                        backgroundColor: "#ecfdf5",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          marginBottom: "6px",
                        }}
                      >
                        <span style={{ fontSize: "22px" }}>🏆</span>
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "#065f46",
                          }}
                        >
                          Top choice
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "20px",
                          fontWeight: 700,
                          color: "#064e3b",
                          marginBottom: "4px",
                        }}
                      >
                        {tally.option.title}
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: hasReds ? "#b91c1c" : "#047857",
                        }}
                      >
                        {summary}
                      </div>
                    </div>
                  );
                })}

                {/* All options summary — only when there are options */}
                {computed(() => {
                  const list = ranked;
                  if (!list || list.length === 0) return null;
                  const me = trimmedName(myName);
                  return (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#6b7280",
                          marginBottom: "10px",
                        }}
                      >
                        All options
                      </div>
                      {list.map((tally) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "6px 10px",
                            marginBottom: "4px",
                            backgroundColor: "white",
                            border: "1px solid #e5e7eb",
                            borderRadius: "6px",
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                              fontSize: "13px",
                              fontWeight: 500,
                              color: "#111827",
                            }}
                          >
                            {tally.option.title}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              flexWrap: "wrap",
                              justifyContent: "flex-end",
                            }}
                          >
                            {tally.voters.map((v) => (
                              <span
                                title={v.name}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  minWidth: "22px",
                                  height: "22px",
                                  padding: "0 6px",
                                  borderRadius: "9999px",
                                  backgroundColor: VOTE_SWATCH[v.voteType],
                                  color: "white",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  boxShadow: v.name === me
                                    ? "0 0 0 2px white, 0 0 0 3px #111827"
                                    : "none",
                                }}
                              >
                                {getInitials(v.name)}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}

                {/* Empty state */}
                {computed(() => {
                  if (options && options.length > 0) return null;
                  const me = trimmedName(myName);
                  const admin = trimmedName(adminName);
                  const amAdmin = me !== "" && me === admin;
                  const hint = amAdmin
                    ? "Add the first one above."
                    : admin !== ""
                    ? `${admin} can add the first option.`
                    : "Waiting for a host to join.";
                  return (
                    <div
                      style={{
                        padding: "32px 20px",
                        border: "1px dashed #d1d5db",
                        borderRadius: "8px",
                        textAlign: "center",
                        color: "#6b7280",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "32px",
                          marginBottom: "8px",
                        }}
                      >
                        🍽️
                      </div>
                      <div style={{ fontSize: "14px", fontWeight: 600 }}>
                        No options yet
                      </div>
                      <div style={{ fontSize: "13px", marginTop: "4px" }}>
                        {hint}
                      </div>
                    </div>
                  );
                })}

                {/* Interactive options — vote per option */}
                {options.map((option) => {
                  const oid = option.id;
                  const optionTitle = option.title;
                  const myVote = derive(
                    { votes, myName, optionId: oid },
                    ({ votes, myName, optionId }) =>
                      myVoteFor(votes, trimmedName(myName), optionId),
                  );
                  const rank = derive(
                    { ranked, optionId: oid },
                    ({ ranked, optionId }) => {
                      const idx = ranked.findIndex(
                        (t) => t.option.id === optionId,
                      );
                      return idx >= 0 ? idx + 1 : 0;
                    },
                  );
                  // Vote buttons toggle: clicking your active color clears
                  // it; clicking a different color updates. Keeps the button
                  // row a stable 3-chip group regardless of state.
                  const onVoteGreen = () =>
                    myVote === "green"
                      ? boundClearMyVote.send({ optionId: oid })
                      : boundCastVote.send({
                        optionId: oid,
                        voteType: "green",
                      });
                  const onVoteYellow = () =>
                    myVote === "yellow"
                      ? boundClearMyVote.send({ optionId: oid })
                      : boundCastVote.send({
                        optionId: oid,
                        voteType: "yellow",
                      });
                  const onVoteRed = () =>
                    myVote === "red"
                      ? boundClearMyVote.send({ optionId: oid })
                      : boundCastVote.send({
                        optionId: oid,
                        voteType: "red",
                      });
                  return (
                    <div
                      style={{
                        marginBottom: "10px",
                        padding: "10px 12px",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        backgroundColor: "white",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <span
                        style={{
                          minWidth: "28px",
                          height: "28px",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "9999px",
                          backgroundColor: "#f3f4f6",
                          color: "#374151",
                          fontSize: "12px",
                          fontWeight: 700,
                        }}
                      >
                        #{rank}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: "14px",
                            color: "#111827",
                          }}
                        >
                          {optionTitle}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            display: "flex",
                            gap: "6px",
                            alignItems: "baseline",
                          }}
                        >
                          <span>added by {option.addedByName}</span>
                          {
                            /* Admin-only Remove — inline with the "added by"
                              metadata, muted, far from the vote chips. */
                          }
                          {isAdmin
                            ? (
                              <button
                                type="button"
                                aria-label="Remove option (host)"
                                style={{
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "#9ca3af",
                                  fontSize: "11px",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  boundRemoveOption.send({ optionId: oid })}
                              >
                                · remove
                              </button>
                            )
                            : null}
                        </div>
                      </div>
                      {isJoined
                        ? (
                          <div
                            style={{
                              display: "flex",
                              gap: "6px",
                              alignItems: "center",
                            }}
                          >
                            <cf-button
                              aria-label={myVote === "green"
                                ? "Clear my green vote"
                                : "Love it"}
                              style={myVote === "green"
                                ? "background-color: #22c55e; color: white; font-weight: bold; border: 2px solid #16a34a;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={onVoteGreen}
                            >
                              🟢
                            </cf-button>
                            <cf-button
                              aria-label={myVote === "yellow"
                                ? "Clear my yellow vote"
                                : "Okay with it"}
                              style={myVote === "yellow"
                                ? "background-color: #eab308; color: white; font-weight: bold; border: 2px solid #ca8a04;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={onVoteYellow}
                            >
                              🟡
                            </cf-button>
                            <cf-button
                              aria-label={myVote === "red"
                                ? "Clear my red vote"
                                : "Veto"}
                              style={myVote === "red"
                                ? "background-color: #ef4444; color: white; font-weight: bold; border: 2px solid #dc2626;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={onVoteRed}
                            >
                              🔴
                            </cf-button>
                          </div>
                        )
                        : null}
                    </div>
                  );
                })}

                {/* Host controls — only the admin sees this card. */}
                {isAdmin
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#eff6ff",
                        border: "1px solid #bfdbfe",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#1e40af",
                          marginBottom: "8px",
                        }}
                      >
                        Host controls
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                        }}
                      >
                        <cf-input
                          $value={optionDraft}
                          placeholder="Add an option (e.g. Sushi place)…"
                          aria-label="Option title"
                          timing-strategy="immediate"
                          style="flex:1"
                        />
                        <cf-button onClick={boundAddOption}>Add</cf-button>
                        <cf-button onClick={boundResetVotes}>
                          Reset votes
                        </cf-button>
                      </div>
                    </div>
                  )
                  : null}
              </div>
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
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
    };
  },
);
