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
 *   immutable thereafter. The join name/avatar come from the viewer's shared
 *   profile (`wish({ query: "#profile" })` — its built-in UI covers profile
 *   create/pick); programmatic callers can still pass an explicit name in the
 *   `joinAs` event.
 * - The first joiner's name is captured into `adminName` (per-space). They can
 *   add/remove options and reset votes. `isAdmin` is derived, not stored.
 * - Open host takeover: any joined participant can `claimHost`, transferring
 *   the role (and the host controls) to themselves. Deliberately ungated
 *   beyond "must be joined"; see `ADMIN-FUTURE.md`.
 *
 * "We went here" history (Lunch Coordinator roadmap #1): the host logs where
 * the group actually ate via each option's "we went here" button. A host date
 * field backdates the next log (blank = today; `logVisit` also takes an
 * explicit `wentAt`). The log shows as a "Recently eaten" list below the
 * options (8 most recent); the host can delete a single mistaken entry
 * (`removeHistoryEntry`) or clear the whole log.
 *
 * Storage: visits live in a `PerSpace<HistoryEntry[]>` array, capped at the
 * MAX_HISTORY most recent (by date). Each `logVisit` embeds a snapshot of
 * everyone's current vote in the entry's `votes` list — the option title is
 * denormalized, so the snapshot survives the option being removed. The
 * "📊 Lunch stats" card derives per-place visit + green/yellow/red tallies from
 * those embedded snapshots via a plain `computed` (the `tallyOptions` idiom).
 * Live voting stays on the in-cell `votes` array. Each entry — and each embedded
 * vote — carries a frozen name snapshot plus a live `Cell<User>` profile link
 * (the shared-profile-roster live-link idiom).
 *
 * History was briefly backed by the SQLite builtin (#4144/#4145, to dogfood it),
 * but that brought a deployed-piece "invalid database handle" failure plus a
 * stack of workarounds (a write-counter to force query re-runs, TEXT-encoded
 * timestamps, async settle races). It is now back on plain fabric storage.
 */

import {
  type Cell,
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
import PollOptionCard from "./poll-option-card.tsx";
import ParticipantIdentityCard from "./participant-identity-card.tsx";

export interface User {
  name: string;
  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;
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

/**
 * A snapshot of one person's vote at the moment a visit was logged, embedded in
 * the visit's `votes` list. `optionTitle` is denormalized (options can be
 * removed later; the title is the meaningful record). `voter` is a frozen name
 * snapshot; `voterLink` is a live `Cell<User>` link to that voter's profile
 * (null if the voter is no longer in the directory).
 */
export interface VoteSnapshot {
  voter: string;
  voterLink: Cell<User> | null;
  optionTitle: string;
  color: VoteColor;
}

/**
 * A place the group actually ate, logged by the host — one entry in the
 * `PerSpace<HistoryEntry[]>` visit log. `loggedByName` is a frozen name snapshot
 * (what the "Recently eaten" card renders); `loggedBy` is a live `Cell<User>`
 * link to the logging host's profile (null if absent). `votes` embeds the vote
 * snapshot taken at log time, so per-place stats survive an option's removal.
 */
export interface HistoryEntry {
  id: string;
  title: string;
  loggedByName: string;
  loggedBy: Cell<User> | null;
  wentAt: number;
  votes: VoteSnapshot[];
}

/**
 * A "Lunch stats" row — the `placeStats` aggregate. Per visited place: how many
 * times we went, and the green/yellow/red tallies of the votes cast FOR that
 * place (across all its visits' snapshots).
 */
export interface PlaceStat {
  title: string;
  visits: number;
  greens: number;
  yellows: number;
  reds: number;
}

/**
 * Log a visit — by existing option id, or a free-typed place title.
 * `wentAt` backdates the entry (ms epoch); omitted → the host's date draft,
 * which itself defaults to today.
 */
export interface LogVisitEvent {
  optionId?: string;
  title?: string;
  wentAt?: number;
}

export interface RemoveHistoryEntryEvent {
  id: string;
}

export type ClearHistoryEvent = Record<PropertyKey, never>;

type QuestionCell = Writable<string | Default<"Where should we eat?">>;
type OptionsCell = Writable<Option[] | Default<[]>>;
type VotesCell = Writable<Vote[] | Default<[]>>;
type UsersCell = Writable<User[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;
type HistoryCell = Writable<HistoryEntry[] | Default<[]>>;

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

// The deterministic key a vote is addressed by: a voter's vote for one option.
// castVote, clearMyVote, and the removeOption cascade all derive the same key,
// so they reach the same vote entity in any session without scanning the list.
const voteKey = (voterName: string, optionId: string): string =>
  JSON.stringify([voterName, optionId]);

// Clear a vote's entity document. The entity outlives its membership link, so a
// removal that only drops the link would leave the entity holding the removed
// vote's content; a later read by the same key (the castVote toggle decision)
// would then see that stale content and treat the absent vote as present.
// Removing a vote always pairs the link removal with this clear.
const clearVoteEntity = (votes: VotesCell, key: string): void => {
  const vote: Writable<Vote | undefined> = votes.elementById(key);
  vote.set(undefined);
};

const getInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(
    0,
    2,
  );
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const newHistoryId = () =>
  `h_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

// Parse a "YYYY-MM-DD" draft (from the host's date input) into a timestamp,
// anchored to local midnight. Blank or unparseable → now. Only ever called
// from a handler, so reading the clock here is fine.
const parseVisitDate = (draft: string | undefined): number => {
  const s = (draft ?? "").trim();
  if (!s) return safeDateNow();
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? safeDateNow() : t;
};

// Cap the stored visit log at the most-recent MAX_HISTORY entries (by date). A
// fabric array lives in one cell, so an unbounded log would grow every computed
// that reads it; 200 is generous for a lunch poll.
const MAX_HISTORY = 200;

// Label for a visit derived purely from its own timestamp — never from the
// current clock, so it stays idempotent inside reactive computations (timestamps
// read against "now" belong in handlers, not computeds). Reads like
// "Tuesday, May 20".
const visitLabel = (wentAt: number): string => {
  const d = new Date(wentAt);
  return `${DAY_NAMES[d.getDay()]}, ${
    d.toLocaleDateString([], { month: "short", day: "numeric" })
  }`;
};

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
  // Address the option by its id so later edits and removal reach it without a
  // positional index. addUnique merges concurrent adds (distinct ids) and is
  // idempotent on the id.
  const id = newOptionId();
  const option = options.elementById(id);
  option.set({
    id,
    title: trimmed,
    addedByName: me,
  });
  options.addUnique(option);
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
  const option = options.elementById(optionId);
  if (!option.get()) return;
  options.removeByValue(option);
  // Cascade: drop every vote for this option, each by its own deterministic
  // key, so votes for other options (including ones cast concurrently) merge
  // through rather than being clobbered by a whole-list rewrite. The explicit
  // read of the vote list is retained, so a concurrent change to it makes this
  // commit conflict and retry, catching votes cast for this option after the
  // read.
  for (const v of votes.get().filter((v) => v.optionId === optionId)) {
    const key = voteKey(v.voterName, optionId);
    votes.removeByValue(votes.elementById(key));
    clearVoteEntity(votes, key);
  }
});

const castVote = handler<CastVoteEvent, {
  votes: VotesCell;
  myName: NameCell;
}>(({ optionId, voteType }, { votes, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  // My vote for this option has a deterministic address, so this reads and
  // edits just that one vote — never the whole list. Clicking the current
  // color toggles the vote off; any other color sets it.
  const key = voteKey(me, optionId);
  const myVote = votes.elementById(key);
  const existing = myVote.get();
  if (existing && existing.voteType === voteType) {
    votes.removeByValue(myVote);
    clearVoteEntity(votes, key);
    return;
  }
  myVote.set({ voterName: me, optionId, voteType });
  votes.addUnique(myVote);
});

const resetVotes = handler<ResetVotesEvent, {
  votes: VotesCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { votes, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  // Clearing the board is an intentional whole-list overwrite. Clear each vote's
  // entity too, so a voter who re-votes their pre-reset color after the reset is
  // not toggled off against the stale entity content.
  for (const v of votes.get()) {
    clearVoteEntity(votes, voteKey(v.voterName, v.optionId));
  }
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
  const key = voteKey(me, optionId);
  votes.removeByValue(votes.elementById(key));
  clearVoteEntity(votes, key);
});

// Host-only, same gate as the other mutating admin actions. Logs where the
// group actually ate — by option id (resolved to its title) or a free title —
// appending an entry to the `visits` array with everyone's current vote
// snapshotted inline. Capped at the MAX_HISTORY most-recent entries (by date).
const logVisit = handler<LogVisitEvent, {
  visits: HistoryCell;
  options: OptionsCell;
  votes: VotesCell;
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  visitDate: NameCell;
}>(
  (
    { optionId, title, wentAt },
    { visits, options, votes, users, myName, adminName, visitDate },
  ) => {
    const me = trimmedName(myName.get());
    const admin = trimmedName(adminName.get());
    if (!me || me !== admin) return;
    let place = trimmedName(title);
    if (!place && optionId) {
      const opt = options.get().find((o) => o.id === optionId);
      place = opt ? trimmedName(opt.title) : "";
    }
    if (!place) return;
    const when = typeof wentAt === "number"
      ? wentAt
      : parseVisitDate(visitDate.get());

    // Resolve a name → that user's live Cell<User> in the directory, for the
    // `*Link` live-profile links (the shared-profile-roster idiom). users.key(i)
    // is a stable cell that round-trips through the array as a link.
    const us = users.get();
    const cellForName = (name: string): Cell<User> | null => {
      const idx = us.findIndex((u) => u.name === name);
      return idx >= 0 ? users.key(idx) : null;
    };

    // Snapshot the current live votes, embedded in the entry. Denormalize the
    // option title (options can be removed later; the title is the record).
    const titleById = new Map(options.get().map((o) => [o.id, o.title]));
    const voteSnapshot: VoteSnapshot[] = [];
    for (const v of votes.get()) {
      const optTitle = trimmedName(titleById.get(v.optionId));
      if (!optTitle) continue; // vote for an already-removed option → skip
      voteSnapshot.push({
        voter: v.voterName,
        voterLink: cellForName(v.voterName),
        optionTitle: optTitle,
        color: v.voteType,
      });
    }

    const entry: HistoryEntry = {
      id: newHistoryId(),
      title: place,
      loggedByName: me,
      loggedBy: cellForName(me),
      wentAt: when,
      votes: voteSnapshot,
    };
    // Append (push round-trips the live links); cap to the MAX_HISTORY most
    // recent only on overflow.
    visits.push(entry);
    const all = visits.get();
    if (all.length > MAX_HISTORY) {
      visits.set(
        [...all].sort((a, b) => b.wentAt - a.wentAt).slice(0, MAX_HISTORY),
      );
    }

    // Reset the date draft so the next log defaults back to today.
    visitDate.set("");
  },
);

const removeHistoryEntry = handler<RemoveHistoryEntryEvent, {
  visits: HistoryCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ id }, { visits, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  // The embedded vote snapshot goes with the entry — no separate cascade.
  visits.set(visits.get().filter((v) => v.id !== id));
});

const clearHistory = handler<ClearHistoryEvent, {
  visits: HistoryCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { visits, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  visits.set([]);
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

// 📊 Lunch stats: per-place visit count + green/yellow/red tallies, derived from
// the embedded vote snapshots. Each entry's `votes` already hold the snapshot
// taken at log time, denormalized by option title; we count only the votes cast
// FOR the visited place (`vote.optionTitle === entry.title`) so a snapshot's
// votes for OTHER options don't leak into this place's tally. Top 5 by visits
// then greens (mirrors the old SQL ORDER BY). A visit with no votes for its own
// place still counts as a visit (the LEFT JOIN semantics it replaces).
const summarizePlaces = (visits: readonly HistoryEntry[]): PlaceStat[] => {
  const byTitle = new Map<string, PlaceStat>();
  for (const entry of visits) {
    let stat = byTitle.get(entry.title);
    if (!stat) {
      stat = { title: entry.title, visits: 0, greens: 0, yellows: 0, reds: 0 };
      byTitle.set(entry.title, stat);
    }
    stat.visits += 1;
    for (const vote of entry.votes) {
      if (vote.optionTitle !== entry.title) continue; // scope to this place
      if (vote.color === "green") stat.greens += 1;
      else if (vote.color === "yellow") stat.yellows += 1;
      else if (vote.color === "red") stat.reds += 1;
    }
  }
  return [...byTitle.values()]
    .sort((a, b) => (b.visits - a.visits) || (b.greens - a.greens))
    .slice(0, 5);
};

export interface CozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  // Durable "we went here" log; each entry embeds its own vote snapshot. Capped
  // at MAX_HISTORY most-recent entries in `logVisit`. optionDraft etc. are
  // internal form drafts, declared as local per-session cells in the pattern
  // body (parking-coordinator idiom).
  visits?: PerSpace<HistoryEntry[] | Default<[]>>;
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
  historyCount: number;
  // The "Recently eaten" list — the 8 most-recent visits, newest first. Exposed
  // so tests and consumers can read the durable visit log.
  recentVisits: readonly HistoryEntry[];
  // Title of the most-recent visit ("" when empty) — a plain scalar that's the
  // most reliable signal for tests (vs. asserting on the array shape).
  mostRecentTitle: string;
  // Total number of embedded vote snapshots across all visits.
  voteHistoryCount: number;
  // The "Lunch stats" aggregate (per-place visit + green/yellow/red tallies of
  // votes cast for that place). Exposed so tests/consumers can read it.
  placeStats: readonly PlaceStat[];
  isJoined: boolean;
  isAdmin: boolean;
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
}

// Stable empty fallbacks for the output snapshots below — fresh `[]` per
// recompute would make the computed results non-idempotent.
const EMPTY_OPTIONS: Option[] = [];
const EMPTY_VOTES: Vote[] = [];
const EMPTY_USERS: User[] = [];

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      options,
      votes,
      users,
      adminName,
      myName,
      visits,
    },
  ) => {
    // Internal per-session form drafts — local to each browser session,
    // not exposed as pattern inputs. Uses the scoped-constructor idiom
    // introduced by parking-coordinator (PR #3610).
    const optionDraft = Writable.perSession.of<string>("");
    // Host's backdate field for "we went here" — a "YYYY-MM-DD" draft, blank
    // means today. Per-session like the other form drafts.
    const visitDate = Writable.perSession.of<string>("");
    // Two-step confirmation for destructive actions. Stores the optionId
    // pending remove-confirm (null = nothing pending). Same idiom as
    // parking-coordinator's `removePersonConfirmTarget`.
    const removeConfirmTarget = Writable.perSession.of<string | null>(null);
    const resetConfirmPending = Writable.perSession.of<boolean>(false);
    const clearHistoryConfirmPending = Writable.perSession.of<boolean>(false);
    const participantIdentity = ParticipantIdentityCard({
      users,
      myName,
      adminName,
    });
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
    const boundLogVisit = logVisit({
      visits,
      options,
      votes,
      users,
      myName,
      adminName,
      visitDate,
    });
    const boundRemoveHistoryEntry = removeHistoryEntry({
      visits,
      myName,
      adminName,
    });
    const boundClearHistory = clearHistory({
      visits,
      myName,
      adminName,
    });
    const userCount = users.length;
    const optionCount = options.length;
    const voteCount = votes.length;
    // The "Recently eaten" card: the 8 most-recent visits (newest first),
    // derived straight from the `visits` array. An array-shaped computed (not a
    // lift-returned VNode) is what lets the card keep its plain-JSX `.map(...)`
    // with interactive onClick delete buttons — those must NOT live inside a
    // lift (they'd mis-lower as "$event in inputs" / a non-idempotent write).
    const recentVisits = computed(() =>
      [...visits].sort((a, b) => b.wentAt - a.wentAt).slice(0, 8)
    );
    // Total visit count + "is there any history?" — derived directly from the
    // array, so they always agree (no two queries settling independently).
    const historyCount = visits.length;
    const hasHistory = computed(() => visits.length > 0);
    const mostRecentTitle = computed(() => {
      const sorted = [...visits].sort((a, b) => b.wentAt - a.wentAt);
      return sorted[0]?.title ?? "";
    });
    // 📊 Lunch stats — per-place visit + green/yellow/red tallies from the
    // embedded vote snapshots (see summarizePlaces for the per-place scoping).
    const placeStats = computed(() => summarizePlaces([...visits]));
    // Total embedded vote snapshots across all visits.
    const voteHistoryCount = computed(() =>
      [...visits].reduce((n, v) => n + v.votes.length, 0)
    );
    // Resolve the viewer's name ONCE here at the top level through the
    // participant identity child. PerUser `myName` does not resolve inside the
    // per-option `options.map(...)` lift; passing this resolved value down
    // avoids that.
    const me = participantIdentity.me;
    const isJoined = participantIdentity.isJoined;
    const isAdmin = participantIdentity.isAdmin;
    // Hoist a boolean cell for the reset-confirm JSX ternary so TS doesn't
    // narrow `resetConfirmPending` itself and lose the `.set` method in
    // the false branch.
    const isResetConfirm = computed(() => resetConfirmPending.get());
    const isClearHistoryConfirm = computed(() =>
      clearHistoryConfirmPending.get()
    );
    const ranked = tallyOptions(options, votes, users);

    const topChoice = voteCount > 0 && ranked.length > 0 ? ranked[0] : null;

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
                    const viewer = me;
                    const amAdmin = isAdmin;
                    // "you are the host" is handled by the HOST chip in the
                    // top right; only call out the host's name to non-admins.
                    const hostNote = !amAdmin && viewer !== "" && admin !== ""
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
                  const viewer = me;
                  if (viewer === "") return null;
                  const amAdmin = isAdmin;
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
                        title={viewer}
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
                        {viewer}
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
                {participantIdentity[UI]}

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
                {options.length > 0
                  ? (
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
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                        }}
                      >
                        {
                          /* Build every row's swatches in ONE top-level
                            `computed` over the resolved `ranked` tally, with
                            plain JS maps. Two reasons this shape, not a reactive
                            `ranked.map(...)`/subpattern or an inline
                            `votes.filter(...)`:
                            1. Votes are links to separate entities; the
                               top-level `tallyOptions` call resolves every
                               voter's entity (including remote ones on another
                               replica), so reading `ranked` here sees them,
                               whereas a `votes.filter` in a nested map sees only
                               the votes a replica has materialized locally.
                            2. A reactive map / subpattern re-renders its per-item
                               swatches unreliably when a remote vote updates a
                               row's voters; a single `computed` re-runs as a
                               whole when `ranked` changes (like the count above),
                               so the swatches track cross-replica votes
                               reliably. `ranked` is pre-sorted, so this also
                               gives the row order with no `order` CSS hack. */
                        }
                        {computed(() =>
                          ranked.map((tally) => (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "6px 10px",
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
                                {tally.voters.map((voter) => (
                                  <span
                                    title={voter.name}
                                    data-vote-swatch-name={voter.name}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      minWidth: "22px",
                                      height: "22px",
                                      padding: "0 6px",
                                      borderRadius: "9999px",
                                      backgroundColor:
                                        VOTE_SWATCH[voter.voteType],
                                      color: "white",
                                      fontSize: "11px",
                                      fontWeight: 700,
                                      boxShadow: voter.name === me
                                        ? "0 0 0 2px white, 0 0 0 3px #111827"
                                        : "none",
                                    }}
                                  >
                                    {getInitials(voter.name)}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )
                  : null}

                {/* Empty state */}
                {computed(() => {
                  if (options && options.length > 0) return null;
                  const admin = trimmedName(adminName);
                  const hint = isAdmin
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
                  // Touch the full option shape here so the mapWithPattern
                  // element schema includes every field the child reads.
                  const cardOption: Option = {
                    id: option.id,
                    title: option.title,
                    addedByName: option.addedByName,
                  };
                  const rank = computed(() => {
                    const idx = ranked.findIndex(
                      (t) => t.option.id === oid,
                    );
                    return idx >= 0 ? idx + 1 : 0;
                  });
                  return (
                    <PollOptionCard
                      option={cardOption}
                      rank={rank}
                      me={me}
                      isJoined={isJoined}
                      isAdmin={isAdmin}
                      votes={votes}
                      removeConfirmTarget={removeConfirmTarget}
                      castVote={boundCastVote}
                      removeOption={boundRemoveOption}
                      logVisit={boundLogVisit}
                    />
                  );
                })}

                {
                  /* Recently eaten — the visit log, shown below the options.
                  Everyone sees it; the host can delete a single mistaken entry
                  (✕) or clear the whole log. Plain JSX with derived-boolean
                  ternaries (the host-controls idiom), NOT a computed-returned
                  VNode, so the interactive onClick handlers lower as handlers
                  rather than lifts ("$event in inputs" / non-idempotent trap). */
                }
                {hasHistory
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#fdf6ec",
                        border: "1px solid #f0e0c8",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          marginBottom: "10px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "#92702a",
                          }}
                        >
                          🗓 Recently eaten
                        </div>
                        {isAdmin
                          ? (isClearHistoryConfirm
                            ? (
                              <span
                                style={{
                                  display: "inline-flex",
                                  gap: "6px",
                                  alignItems: "center",
                                }}
                              >
                                <cf-button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => {
                                    boundClearHistory.send({});
                                    clearHistoryConfirmPending.set(false);
                                  }}
                                >
                                  Clear all
                                </cf-button>
                                <cf-button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    clearHistoryConfirmPending.set(false)}
                                >
                                  Cancel
                                </cf-button>
                              </span>
                            )
                            : (
                              <button
                                type="button"
                                aria-label="Clear all history (host)"
                                style={{
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "#b08642",
                                  fontSize: "11px",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  clearHistoryConfirmPending.set(true)}
                              >
                                clear all
                              </button>
                            ))
                          : null}
                      </div>
                      {recentVisits.map((entry) => {
                        const entryId = entry.id;
                        return (
                          <div
                            data-recent-visit-title={entry.title}
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              justifyContent: "space-between",
                              gap: "8px",
                              padding: "4px 0",
                              fontSize: "13px",
                              color: "#5b4a2c",
                            }}
                          >
                            <span style={{ fontWeight: 500 }}>
                              {entry.title}
                            </span>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "baseline",
                                gap: "8px",
                              }}
                            >
                              <span
                                style={{ fontSize: "12px", color: "#a08552" }}
                              >
                                {visitLabel(entry.wentAt)}
                              </span>
                              {isAdmin
                                ? (
                                  <button
                                    type="button"
                                    aria-label="Delete this visit (host)"
                                    title="We didn't actually eat there"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      padding: 0,
                                      color: "#b08642",
                                      fontSize: "13px",
                                      lineHeight: 1,
                                      cursor: "pointer",
                                    }}
                                    onClick={() =>
                                      boundRemoveHistoryEntry.send({
                                        id: entryId,
                                      })}
                                  >
                                    ✕
                                  </button>
                                )
                                : null}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )
                  : null}

                {
                  /* Lunch stats — a read-only recap from the embedded vote
                  snapshots: per-place visit count + how the group leaned
                  (greens / reds) across every logged visit. Shown to everyone
                  whenever there's any history. No interactive handlers, so the
                  whole-array `.map` is plain and free of the lift hazard the
                  "Recently eaten" card has to dodge. */
                }
                {hasHistory
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#f3f0fb",
                        border: "1px solid #ddd2f0",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#5b3fa3",
                          marginBottom: "10px",
                        }}
                      >
                        📊 Lunch stats
                      </div>
                      {placeStats.map((stat) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: "8px",
                            padding: "4px 0",
                            fontSize: "13px",
                            color: "#473266",
                          }}
                        >
                          <span style={{ fontWeight: 500 }}>{stat.title}</span>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "baseline",
                              gap: "10px",
                              fontSize: "12px",
                            }}
                          >
                            <span style={{ color: "#8a7bb0" }}>
                              {stat.visits}×
                            </span>
                            <span style={{ color: "#2f8a64" }}>
                              🟢 {stat.greens}
                            </span>
                            <span style={{ color: "#b27722" }}>
                              🟡 {stat.yellows}
                            </span>
                            <span style={{ color: "#a33b35" }}>
                              🔴 {stat.reds}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                  : null}

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
                          id="lp-add-option-input"
                          $value={optionDraft}
                          placeholder="Add an option (e.g. Sushi place)…"
                          aria-label="Option title"
                          timing-strategy="immediate"
                          style="flex:1"
                        />
                        <cf-button
                          id="lp-add-option-button"
                          aria-label="Add option"
                          onClick={boundAddOption}
                        >
                          Add
                        </cf-button>
                        {isResetConfirm
                          ? (
                            <>
                              <cf-button
                                variant="primary"
                                onClick={() => {
                                  boundResetVotes.send({});
                                  resetConfirmPending.set(false);
                                }}
                              >
                                Yes, reset
                              </cf-button>
                              <cf-button
                                variant="ghost"
                                onClick={() => resetConfirmPending.set(false)}
                              >
                                Cancel
                              </cf-button>
                            </>
                          )
                          : (
                            <cf-button
                              onClick={() => resetConfirmPending.set(true)}
                            >
                              Reset votes
                            </cf-button>
                          )}
                      </div>
                      {
                        /* Backdates the next "✓ we went here" you click on an
                        option above. Blank = today; cleared after each log. */
                      }
                      <div
                        style={{
                          marginTop: "8px",
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                          flexWrap: "wrap",
                          fontSize: "12px",
                          color: "#1e40af",
                        }}
                      >
                        <span>Date for "✓ we went here":</span>
                        <cf-input
                          type="date"
                          $value={visitDate}
                          aria-label="Visit date (blank = today)"
                          timing-strategy="immediate"
                        />
                        <span style={{ color: "#64748b" }}>
                          (blank = today)
                        </span>
                      </div>
                    </div>
                  )
                  : null}
              </div>
            </cf-vscroll>
          </cf-screen>
        </cf-theme>
      ),
      question,
      // Output snapshots readable from OTHER runtimes (multi-user tests,
      // remote viewers): raw scoped values read as undefined in runtimes that
      // didn't write them, and a computed that RETURNS undefined is
      // indistinguishable from "not yet computed" for cross-runtime readers —
      // so every snapshot yields a real, stable value (the shared EMPTY
      // constants keep the fallback idempotent across recomputes). The visit
      // history is no longer a PerSpace input — it lives in SQLite now and is
      // surfaced via `recentVisits`/`mostRecentTitle` below.
      options: computed(() => options ?? EMPTY_OPTIONS),
      votes: computed(() => votes ?? EMPTY_VOTES),
      users: computed(() => users ?? EMPTY_USERS),
      adminName: computed(() => trimmedName(adminName)),
      myName: participantIdentity.me,
      userCount,
      optionCount,
      voteCount,
      historyCount,
      recentVisits,
      mostRecentTitle,
      voteHistoryCount,
      placeStats,
      isJoined: participantIdentity.isJoined,
      isAdmin: participantIdentity.isAdmin,
      joinAs: participantIdentity.joinAs,
      claimHost: participantIdentity.claimHost,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
      logVisit: boundLogVisit,
      removeHistoryEntry: boundRemoveHistoryEntry,
      clearHistory: boundClearHistory,
    };
  },
);
