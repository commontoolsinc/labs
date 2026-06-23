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
 * Storage (dogfooding the SQLite builtins, PRs #3776/#3848): visits live in a
 * SQLite `visits` table — not the former `PerSpace<HistoryEntry[]>` array — so
 * there's no MAX_HISTORY cap and "Recently eaten" is a `db.query` (the read
 * bounds itself with LIMIT). Each `logVisit` also snapshots everyone's current
 * vote into a `vote_history` table tied to that visit; the "📊 Lunch stats"
 * card surfaces per-place visit + green/red tallies from it. Live voting is
 * stored under each participant row and projected back to the public `votes`
 * output; only the durable visit record is in SQLite. Both tables carry a
 * frozen TEXT name plus a `cfLink<User>` live profile pointer.
 *
 * KNOWN ISSUE (open): correct + green in the emulated `cf test` runner, but on a
 * *deployed* piece `db.exec` throws "invalid database handle" (a sqlite-builtin
 * × scoped-pattern interaction, reliably reproduced, root cause still open —
 * see the session finding doc). Don't cut over the live canonical piece yet.
 * See `LUNCH-COORDINATOR-TODO.md`.
 */

import {
  type Cell,
  cfLink,
  computed,
  Default,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  sqliteDatabase,
  type SqliteDb,
  Stream,
  table,
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
  votes?: UserVote[] | Default<[]>;
}

export interface Option {
  id: string;
  title: string;
  addedByName: string;
  // Homepage link enrichment, persisted so we don't re-run the grounded web
  // search on every load. `homePageUrl` is the auto-found official site; a host
  // can refresh it. `homePageUrlOverride` is a human-supplied link that wins.
  homePageUrl?: string;
  homePageUrlOverride?: string;
  // Host-generated dish illustration, shared after the host receives it.
  imageUrl?: string;
}

const WEB_SEARCH_URL = "/api/agent-tools/web-search";

export type VoteColor = "green" | "yellow" | "red";

export interface UserVote {
  optionId: string;
  voteType: VoteColor;
}

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
 * A place the group actually ate, logged by the host. Persisted in the SQLite
 * `visits` table (replacing the former `history: PerSpace<HistoryEntry[]>`
 * array). Column names are snake_case to read naturally in SQL; this interface
 * documents the logical shape.
 */
export interface HistoryEntry {
  id: string;
  title: string;
  loggedByName: string;
  wentAt: number;
}

/**
 * A row of the `visits` query result. `logged_by` is a frozen name snapshot
 * (what the "Recently eaten" card renders); `logged_by_cf_link` is a live
 * pointer to the logging user's profile (dogfoods the cfLink feature). See the
 * KNOWN ISSUE note on the `sqliteDatabase(...)` call about deployed pieces.
 */
export interface VisitRow {
  id: string;
  title: string;
  logged_by: string;
  logged_by_cf_link: Cell<User>;
  // Stored as zero-padded TEXT (see encodeTs) — decode with Number() / decodeTs.
  went_at: string;
}

/**
 * A row of the `vote_history` table — a snapshot of one person's vote at the
 * moment a visit was logged. `option_title` is denormalized (options get
 * removed; the title is the meaningful record). `voter` is a frozen name (no
 * cfLink — same deployed-piece reason as VisitRow).
 */
export interface VoteHistoryRow {
  id: string;
  visit_id: string;
  voter: string;
  voter_cf_link: Cell<User>;
  option_title: string;
  vote_color: VoteColor;
  // Stored as zero-padded TEXT (see encodeTs) — decode with Number() / decodeTs.
  went_at: string;
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
type CityCell = Writable<string | Default<"Berkeley, CA">>;
type LinkTargetCell = Writable<string | null>;
type OptionsCell = Writable<Option[] | Default<[]>>;
type VotesCell = Writable<Vote[] | Default<[]>>;
type UsersCell = Writable<User[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;
type UserIndexCell = Writable<number | Default<-1>>;
type HomePageRefreshCell = Writable<number>;
// A monotonic write counter bumped by the sqlite-mutating handlers; the
// db.query calls react on THIS rather than on `db`. In the test runner,
// `reactOn: db` does not reliably re-run a query after a committed db.exec,
// whereas bumping a plain PerSpace counter and reacting on it does. (The spec's
// in-commit `rev`-bump model is meant to make `reactOn: db` work; until it does
// here, the counter is the dependable trigger.)
type RevCell = Writable<number | Default<0>>;

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

// Normalize a human-entered link to a safe http(s) URL. Returns "" for anything
// that isn't http/https — this is what keeps a pasted `javascript:`/`data:`
// override from ever reaching an `href`. We parse the value as-is first (so a
// real `http(s)://` URL is honored), and only on failure retry with an
// `https://` prefix — so a scheme-less `host:port` like `example.com:8080`
// isn't mistaken for a `scheme:` and rejected. Also used defensively at render.
const httpsOrNull = (candidate: string): string | null => {
  try {
    const u = new URL(candidate);
    return (u.protocol === "http:" || u.protocol === "https:")
      ? u.toString()
      : null;
  } catch {
    return null;
  }
};
const safeHttpUrl = (raw: string | undefined): string => {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return httpsOrNull(s) ?? httpsOrNull(`https://${s}`) ?? "";
};

const safeImageUrl = (raw: string | undefined): string => {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("data:image/")) return s;
  return safeHttpUrl(s);
};

const homePageLookupUrlFor = (
  isAdmin: boolean,
  _refresh: number,
  storedUrl: string | undefined,
  overrideUrl: string | undefined,
  endpoint: string,
): string =>
  isAdmin && !trimmedName(storedUrl) && !trimmedName(overrideUrl)
    ? endpoint
    : "";

const newOptionId = () =>
  `o_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

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

// We store ms-epoch timestamps as zero-padded TEXT, not as SQLite `integer`.
// Why: the @db/sqlite binding the runtime uses truncates a bound JS number to
// 32 bits, so a real ms-epoch (~1.7e12) round-trips as a negative garbage value
// (and passing a BigInt doesn't help in this version). TEXT round-trips the
// value losslessly; 16-digit zero-padding keeps lexicographic ORDER BY equal to
// numeric order for every non-negative timestamp (covers dates well past 3000).
// If/when the integer-binding bug is fixed upstream, this can revert to a plain
// `integer` column. (Surfaced while dogfooding the SQLite builtin — worth
// reporting upstream.)
const TS_WIDTH = 16;
const encodeTs = (ms: number): string =>
  Math.max(0, Math.trunc(ms)).toString().padStart(TS_WIDTH, "0");
const decodeTs = (s: string | undefined): number => Number(s ?? 0);

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
  options.push({
    id: newOptionId(),
    title: trimmed,
    addedByName: me,
    homePageUrl: "",
    homePageUrlOverride: "",
    imageUrl: "",
  });
  optionDraft.set("");
});

export interface SetCityEvent {
  city?: string;
}

// Host sets the city the poll is happening in. This scopes the menu-link web
// search to local restaurants. Gate: host only.
const setCity = handler<SetCityEvent, {
  city: CityCell;
  myName: NameCell;
  adminName: NameCell;
  cityDraft: NameCell;
}>(({ city: cityArg }, { city, myName, adminName, cityDraft }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const next = trimmedName(cityArg ?? cityDraft.get());
  if (!next) return;
  city.set(next);
  cityDraft.set("");
});

export type EnrichHomePagesEvent = Record<PropertyKey, never>;

// Host-only: bump the shared refresh marker. The actual homepage lookup is a
// reactive fetchData node per option, so the handler never waits on network I/O.
const enrichHomePages = handler<EnrichHomePagesEvent, {
  myName: NameCell;
  adminName: NameCell;
  homePageRefresh: HomePageRefreshCell;
}>((_evt, { myName, adminName, homePageRefresh }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  homePageRefresh.set(Number(homePageRefresh.get() ?? 0) + 1);
});

export interface SetOptionUrlEvent {
  optionId: string;
  url?: string;
}

const setOptionHomePageUrl = handler<SetOptionUrlEvent, {
  options: OptionsCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ optionId, url }, { options, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const cur = options.get();
  const idx = cur.findIndex((o) => o.id === optionId);
  if (idx < 0) return;
  const safe = safeHttpUrl(url ?? "");
  if (!safe || trimmedName(cur[idx]?.homePageUrl) === safe) return;
  options.key(idx).key("homePageUrl").set(safe);
});

// Any joined user supplies/overrides the homepage link for an option. An empty
// value clears the override (reverting to the auto-enriched value). The
// override always wins over the auto-found URL.
const setOptionUrl = handler<SetOptionUrlEvent, {
  options: OptionsCell;
  myName: NameCell;
  linkDraft: NameCell;
  linkEditTarget: LinkTargetCell;
}>(({ optionId, url }, { options, myName, linkDraft, linkEditTarget }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  const cur = options.get();
  const idx = cur.findIndex((o) => o.id === optionId);
  if (idx < 0) return;
  const raw = trimmedName(url ?? linkDraft.get());
  // Empty clears the override; otherwise only accept a safe http(s) URL. A
  // non-empty value that isn't http(s) (e.g. `javascript:`) is rejected — leave
  // the existing override and the edit field open so it can be corrected.
  const safe = raw === "" ? "" : safeHttpUrl(raw);
  if (raw !== "" && safe === "") return;
  options.key(idx).key("homePageUrlOverride").set(safe);
  linkDraft.set("");
  linkEditTarget.set(null);
});

export interface SetOptionImageEvent {
  optionId: string;
  imageUrl?: string;
}

const setOptionImage = handler<SetOptionImageEvent, {
  options: OptionsCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ optionId, imageUrl }, { options, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const cur = options.get();
  const idx = cur.findIndex((o) => o.id === optionId);
  if (idx < 0) return;
  const safe = safeImageUrl(imageUrl);
  if (!safe || trimmedName(cur[idx]?.imageUrl) === safe) return;
  options.key(idx).key("imageUrl").set(safe);
});

const removeOption = handler<RemoveOptionEvent, {
  options: OptionsCell;
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ optionId }, { options, users, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const current = options.get();
  const target = current.find((o) => o.id === optionId);
  if (!target) return;
  options.remove(target);
  users.get().forEach((_user, userIndex) => {
    const userVotes = users.key(userIndex).key("votes");
    const rawVotes = userVotes.get();
    const currentVotes: readonly UserVote[] = Array.isArray(rawVotes)
      ? rawVotes as readonly UserVote[]
      : [];
    if (currentVotes.length === 0) return;
    userVotes.set(currentVotes.filter((v) => v.optionId !== optionId));
  });
});

const castVote = handler<CastVoteEvent, {
  users: UsersCell;
  myUserIndex: UserIndexCell;
}>(({ optionId, voteType }, { users, myUserIndex }) => {
  const userIndex = myUserIndex.get();
  if (!Number.isInteger(userIndex) || userIndex < 0) return;
  const user = users.key(userIndex);
  if (!user.get()) return;

  const userVotes = user.key("votes");
  const rawVotes = userVotes.get();
  const current: readonly UserVote[] = Array.isArray(rawVotes)
    ? rawVotes as readonly UserVote[]
    : [];
  if (!Array.isArray(rawVotes)) {
    userVotes.set([]);
  }

  const existingIdx = current.findIndex(
    (v) => v.optionId === optionId,
  );
  if (existingIdx >= 0) {
    const existing = current[existingIdx];
    if (existing.voteType === voteType) {
      userVotes.remove(existing);
      return;
    }
    userVotes.key(existingIdx).key("voteType").set(voteType);
    return;
  }
  userVotes.push({ optionId, voteType });
});

const resetVotes = handler<ResetVotesEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { users, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  users.get().forEach((_user, userIndex) => {
    users.key(userIndex).key("votes").set([]);
  });
});

export interface ClearVoteEvent {
  optionId: string;
}

const clearMyVote = handler<ClearVoteEvent, {
  users: UsersCell;
  myUserIndex: UserIndexCell;
}>(({ optionId }, { users, myUserIndex }) => {
  const userIndex = myUserIndex.get();
  if (!Number.isInteger(userIndex) || userIndex < 0) return;
  const user = users.key(userIndex);
  if (!user.get()) return;

  const userVotes = user.key("votes");
  const rawVotes = userVotes.get();
  const currentVotes: readonly UserVote[] = Array.isArray(rawVotes)
    ? rawVotes as readonly UserVote[]
    : [];
  if (currentVotes.length === 0) return;
  userVotes.set(currentVotes.filter((v) => v.optionId !== optionId));
});

const votesForUsers = (users: readonly User[]): Vote[] =>
  users.flatMap((user) =>
    (user.votes ?? []).map((vote) => ({
      voterName: user.name,
      optionId: vote.optionId,
      voteType: vote.voteType,
    }))
  );

// Host-only, same gate as the other mutating admin actions. Logs where the
// group actually ate — by option id (resolved to its title) or a free title —
// into the SQLite `visits` table, and snapshots everyone's current vote into
// `vote_history`. All db.exec writes here fold into the one handler commit.
//
// SQLite carries the cap that the old in-cell array needed: no MAX_HISTORY
// pruning — the table grows fine, and the read query bounds what's shown.
const logVisit = handler<LogVisitEvent, {
  db: SqliteDb;
  options: OptionsCell;
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  visitDate: NameCell;
  rev: RevCell;
}>(
  (
    { optionId, title, wentAt },
    { db, options, users, myName, adminName, visitDate, rev },
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
    const whenText = encodeTs(when); // see encodeTs: timestamps stored as TEXT
    const visitId = newHistoryId();

    // Resolve a name → that user's live Cell<User> in the directory, for the
    // `*_cf_link` columns. users.key(i) is a stable, toCell-bearing cell; a
    // cell may only be bound to a _cf_link column (binding elsewhere throws).
    const us = users.get();
    const cellForName = (name: string): Cell<User> | null => {
      const idx = us.findIndex((u) => u.name === name);
      return idx >= 0 ? users.key(idx) : null;
    };
    const hostCell = cellForName(me);

    db.exec(
      "INSERT INTO visits (id, title, logged_by, logged_by_cf_link, went_at) VALUES (?, ?, ?, ?, ?)",
      // a _cf_link param must never be undefined; pass null for an absent cell.
      [visitId, place, me, hostCell ?? null, whenText],
    );

    // Snapshot the current live votes tied to this visit. Denormalize the
    // option title (options can be removed later; the title is the record).
    const titleById = new Map(options.get().map((o) => [o.id, o.title]));
    for (const v of votesForUsers(users.get())) {
      const optTitle = trimmedName(titleById.get(v.optionId));
      if (!optTitle) continue; // vote for an already-removed option → skip
      db.exec(
        "INSERT INTO vote_history (id, visit_id, voter, voter_cf_link, option_title, vote_color, went_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          `${visitId}_${v.voterName}_${v.optionId}`,
          visitId,
          v.voterName,
          cellForName(v.voterName) ?? null,
          optTitle,
          v.voteType,
          whenText,
        ],
      );
    }

    // Reset the date draft so the next log defaults back to today.
    visitDate.set("");
    // Bump the write counter so the reactOn:rev queries re-run (see RevCell).
    rev.set((rev.get() ?? 0) + 1);
  },
);

const removeHistoryEntry = handler<RemoveHistoryEntryEvent, {
  db: SqliteDb;
  myName: NameCell;
  adminName: NameCell;
  rev: RevCell;
}>(({ id }, { db, myName, adminName, rev }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  db.exec("DELETE FROM visits WHERE id = ?", [id]);
  // Drop the vote snapshot for that visit too, so the two tables stay aligned.
  db.exec("DELETE FROM vote_history WHERE visit_id = ?", [id]);
  rev.set((rev.get() ?? 0) + 1);
});

const clearHistory = handler<ClearHistoryEvent, {
  db: SqliteDb;
  myName: NameCell;
  adminName: NameCell;
  rev: RevCell;
}>((_, { db, myName, adminName, rev }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  db.exec("DELETE FROM visits", []);
  db.exec("DELETE FROM vote_history", []);
  rev.set((rev.get() ?? 0) + 1);
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

export interface CozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  // City the poll is happening in — scopes the menu-link web search so it
  // finds the right local restaurants. Defaults to Berkeley, CA.
  city?: PerSpace<string | Default<"Berkeley, CA">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  myUserIndex?: PerUser<number | Default<-1>>;
  webSearchUrl?: PerSpace<string | Default<typeof WEB_SEARCH_URL>>;
  // Write counter bumped by the sqlite-mutating handlers; the db.query calls
  // react on this rather than on `db` directly (see RevCell for why).
  sqliteRev?: PerSpace<number | Default<0>>;
  // Visit history + the vote-history snapshots now live in a SQLite database
  // owned by the pattern body (`sqliteDatabase(...)`), not a PerSpace input.
  // optionDraft etc. are internal form drafts, declared as local
  // per-session cells in the pattern body (parking-coordinator idiom).
}

export interface CozyPollOutput {
  [NAME]: string;
  [UI]: VNode;
  question: string;
  city: string;
  options: readonly Option[];
  votes: readonly Vote[];
  users: readonly User[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  historyCount: number;
  // The "Recently eaten" SQLite query result ({ pending, result, error }).
  // Exposed so tests and consumers can read the durable visit log.
  recentVisits: { pending: boolean; result?: VisitRow[]; error?: unknown };
  // Title of the most-recent visit ("" when empty) — a plain scalar that's the
  // most reliable signal for tests (vs. asserting on the result array shape).
  mostRecentTitle: string;
  // Count of rows in the vote_history snapshot table.
  voteHistoryCount: number;
  // The "Lunch stats" aggregate (per-place visit + green/yellow/red tallies of
  // votes cast for that place). Exposed so tests/consumers can read it.
  placeStats: readonly PlaceStat[];
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

// Stable empty fallbacks for the output snapshots below — fresh `[]` per
// recompute would make the computed results non-idempotent.
const EMPTY_OPTIONS: Option[] = [];
const EMPTY_USERS: User[] = [];

interface OptionSummaryRowInput {
  title: string;
  voters: readonly { name: string; voteType: VoteColor; color: string }[];
  me: string;
}

interface OptionSummaryRowOutput {
  [NAME]: string;
  [UI]: VNode;
}

// One row of the compact "All options" overview: the option title plus a
// swatch per voter who picked it. `voters` is the pattern input — a top-level
// reactive binding — so `voters.map(...)` lowers to a reactive mapping. The
// parent feeds each row a single option's voters (from `ranked`), so the
// chips count the actual votes rather than options × votes. Mapping a per-item
// field of `ranked` inline (e.g. `tally.voters.map(...)`) instead is rejected
// at runtime — `OpaqueRef.map` has no stable per-item identity to lower.
const OptionSummaryRow = pattern<OptionSummaryRowInput, OptionSummaryRowOutput>(
  ({ title, voters, me }) => ({
    [NAME]: "Option summary row",
    [UI]: (
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
          {title}
        </div>
        <div
          style={{
            display: "flex",
            gap: "4px",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          {voters.map((voter) => (
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
                backgroundColor: VOTE_SWATCH[voter.voteType],
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
    ),
  }),
);

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      city,
      options,
      users,
      adminName,
      myName,
      myUserIndex,
      webSearchUrl,
      sqliteRev,
    },
  ) => {
    // SQLite database owned by this pattern (default cell-derived source). The
    // visit log and the per-visit vote snapshots live here; the runtime owns
    // table creation/migration from this declaration. `*_cf_link` columns store
    // a live Cell<User> reference alongside the frozen TEXT name.
    //
    // KNOWN ISSUE (open): on a *deployed* piece (not the emulated test runner),
    // `db.exec` in these handlers throws "invalid database handle". It is NOT
    // the cf-link alone (removing it didn't fix it) — it's a subtler interaction
    // of this scoped (PerUser+PerSpace) pattern's multiple db.query calls with
    // the write handle. Reliably reproduced; root cause still open; filed for
    // the sqlite-builtin owner. The pattern is correct + green in `cf test`
    // (emulated MemoryV2Server). Do NOT cut over the live canonical piece until
    // it's fixed. See session_outputs/2026-06-04_lunch-poll-sqlite/.
    const db = sqliteDatabase({
      tables: {
        visits: table({
          id: "text primary key",
          title: "text",
          logged_by: "text",
          logged_by_cf_link: cfLink<User>(),
          // ms-epoch as zero-padded TEXT, not integer — see encodeTs.
          went_at: "text",
        }),
        vote_history: table({
          id: "text primary key",
          visit_id: "text",
          voter: "text",
          voter_cf_link: cfLink<User>(),
          option_title: "text",
          vote_color: "text",
          went_at: "text",
        }),
      },
    });
    // Internal per-session form drafts — local to each browser session,
    // not exposed as pattern inputs. Uses the scoped-constructor idiom
    // introduced by parking-coordinator (PR #3610).
    const optionDraft = Writable.perSession.of<string>("");
    // Host's draft for the poll's city (scopes the menu web search).
    const cityDraft = Writable.perSession.of<string>("");
    // Which option's homepage link is being edited (null = none), plus the
    // in-progress URL text. Per-session, like the other form drafts.
    const linkEditTarget = Writable.perSession.of<string | null>(null);
    const linkDraft = Writable.perSession.of<string>("");
    // Host's backdate field for "we went here" — a "YYYY-MM-DD" draft, blank
    // means today. Per-session like the other form drafts.
    const visitDate = Writable.perSession.of<string>("");
    // Two-step confirmation for destructive actions. Stores the optionId
    // pending remove-confirm (null = nothing pending). Same idiom as
    // parking-coordinator's `removePersonConfirmTarget`.
    const removeConfirmTarget = Writable.perSession.of<string | null>(null);
    const resetConfirmPending = Writable.perSession.of<boolean>(false);
    const clearHistoryConfirmPending = Writable.perSession.of<boolean>(false);
    // Shared marker that retriggers the host's reactive homepage lookup nodes.
    // Missing homepage links are also looked up on first host load.
    const homePageRefresh = Writable.perSpace.of<number>(0);
    const participantIdentity = ParticipantIdentityCard({
      users,
      myName,
      myUserIndex,
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
      users,
      myName,
      adminName,
    });
    const boundCastVote = castVote({ users, myUserIndex });
    const boundClearMyVote = clearMyVote({ users, myUserIndex });
    const boundResetVotes = resetVotes({ users, myName, adminName });
    const boundLogVisit = logVisit({
      db,
      options,
      users,
      myName,
      adminName,
      visitDate,
      rev: sqliteRev,
    });
    const boundRemoveHistoryEntry = removeHistoryEntry({
      db,
      myName,
      adminName,
      rev: sqliteRev,
    });
    const boundClearHistory = clearHistory({
      db,
      myName,
      adminName,
      rev: sqliteRev,
    });
    const boundSetCity = setCity({ city, myName, adminName, cityDraft });
    const boundEnrichHomePages = enrichHomePages({
      myName,
      adminName,
      homePageRefresh,
    });
    const boundSetOptionUrl = setOptionUrl({
      options,
      myName,
      linkDraft,
      linkEditTarget,
    });
    const boundSetOptionHomePageUrl = setOptionHomePageUrl({
      options,
      myName,
      adminName,
    });
    const boundSetOptionImage = setOptionImage({
      options,
      myName,
      adminName,
    });
    const userCount = users.length;
    const optionCount = options.length;
    const liveVotes = computed(() => votesForUsers(users));
    const voteCount = liveVotes.length;
    // The "Recently eaten" card, now a SQLite query. It re-runs when the
    // sqliteRev counter changes — the mutating handlers bump it after each
    // db.exec (we react on the counter, not `db`; see RevCell). The read bounds
    // itself with LIMIT 8 — no stored cap needed.
    const recentVisits = db.query<VisitRow>(
      "SELECT id, title, logged_by, logged_by_cf_link, went_at FROM visits ORDER BY went_at DESC LIMIT 8",
      { reactOn: sqliteRev },
    );
    // `recentVisits.result` is `VisitRow[] | undefined`. Coercing with `?? []`
    // inside a computed yields an OpaqueRef<VisitRow[]> structurally identical
    // to the old `recentHistory` array — so the "Recently eaten" card keeps its
    // existing plain-JSX `.map(...)` with interactive onClick handlers, which
    // must NOT live inside a lift-returned VNode (they'd mis-lower as lifts —
    // "$event in inputs" / non-idempotent write). This is the key to migrating
    // the card without reintroducing that bug.
    const recentRows = computed(() => recentVisits.result ?? []);
    const visitCount = db.query<{ n: number }>(
      "SELECT count(*) AS n FROM visits",
      { reactOn: sqliteRev },
    );
    // The true total visit count (can exceed the LIMIT 8 the row query bounds
    // itself to), used only as an exported scalar — never rendered directly.
    const historyCount = computed(() => Number(visitCount.result?.[0]?.n ?? 0));
    // "Is there any history?" gates visibility of the history-derived cards.
    // The bounded row query is the rendering source of truth: on deployed
    // pieces the aggregate count query can transiently resolve 0 while
    // recentVisits already has rows after a source update, so gate on the rows.
    // (Combining the two queries via Math.max() was glitch-prone — they settle
    // independently, so on a delete the max could cling to a stale-high value
    // and never reach the new lower count.)
    const hasRecentRows = computed(() => recentRows.length > 0);
    const hasHistory = hasRecentRows;
    const mostRecentTitle = computed(() =>
      recentVisits.result?.[0]?.title ?? ""
    );
    // 📊 Lunch stats: per-place visit count + green/red tallies across the
    // whole durable record. The join is restricted to vote snapshots cast FOR
    // the visited place (`vh.option_title = v.title`) — each visit snapshots
    // every option's votes, so without that filter the tallies would sum the
    // whole board, not the place we went to. Read-only (no handlers), so it's
    // free of the lift hazard above.
    const placeStats = db.query<PlaceStat>(
      `SELECT v.title AS title,
              count(DISTINCT v.id) AS visits,
              sum(CASE WHEN vh.vote_color = 'green' THEN 1 ELSE 0 END) AS greens,
              sum(CASE WHEN vh.vote_color = 'yellow' THEN 1 ELSE 0 END) AS yellows,
              sum(CASE WHEN vh.vote_color = 'red' THEN 1 ELSE 0 END) AS reds
       FROM visits v
       LEFT JOIN vote_history vh
              ON vh.visit_id = v.id AND vh.option_title = v.title
       GROUP BY v.title
       ORDER BY visits DESC, greens DESC
       LIMIT 5`,
      { reactOn: sqliteRev },
    );
    const placeStatsRows = computed(() => placeStats.result ?? []);
    const voteHistoryCountQuery = db.query<{ n: number }>(
      "SELECT count(*) AS n FROM vote_history",
      { reactOn: sqliteRev },
    );
    const voteHistoryCount = computed(() =>
      voteHistoryCountQuery.result?.[0]?.n ?? 0
    );
    // Resolve the viewer's name ONCE here at the top level through the
    // participant identity child. PerUser `myName` does not resolve inside the
    // per-option `options.map(...)` lift; passing this resolved value down
    // avoids that.
    const me = participantIdentity.me;
    // Resolve the poll's city ONCE here (same reason as `me`): the raw ref
    // doesn't resolve inside the per-option `options.map` lift where the menu
    // search query is built. Blank → Berkeley, CA.
    const cityLabel = trimmedName(city) || "Berkeley, CA";
    const searchEndpoint = trimmedName(webSearchUrl) || WEB_SEARCH_URL;
    const isJoined = participantIdentity.isJoined;
    const isAdmin = participantIdentity.isAdmin;
    // Hoist a boolean cell for the reset-confirm JSX ternary so TS doesn't
    // narrow `resetConfirmPending` itself and lose the `.set` method in
    // the false branch.
    const isResetConfirm = computed(() => resetConfirmPending.get());
    const isClearHistoryConfirm = computed(() =>
      clearHistoryConfirmPending.get()
    );
    const ranked = tallyOptions(options, liveVotes, users);
    const homePageLookupUrls = options.map((option) =>
      homePageLookupUrlFor(
        isAdmin,
        Number(homePageRefresh.get() ?? 0),
        option.homePageUrl,
        option.homePageUrlOverride,
        searchEndpoint,
      )
    );

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
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#6b7280",
                      marginTop: "2px",
                    }}
                  >
                    📍 {cityLabel}
                  </div>
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
                        {ranked.map((tally) => (
                          <OptionSummaryRow
                            title={tally.option.title}
                            voters={tally.voters}
                            me={me}
                          />
                        ))}
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
                    homePageUrl: option.homePageUrl,
                    homePageUrlOverride: option.homePageUrlOverride,
                    imageUrl: option.imageUrl,
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
                      votes={liveVotes}
                      cityLabel={cityLabel}
                      searchEndpoint={searchEndpoint}
                      homePageRefresh={homePageRefresh}
                      linkEditTarget={linkEditTarget}
                      linkDraft={linkDraft}
                      removeConfirmTarget={removeConfirmTarget}
                      castVote={boundCastVote}
                      removeOption={boundRemoveOption}
                      logVisit={boundLogVisit}
                      setOptionUrl={boundSetOptionUrl}
                      setOptionHomePageUrl={boundSetOptionHomePageUrl}
                      setOptionImage={boundSetOptionImage}
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
                {hasRecentRows
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
                      {recentRows.map((entry) => {
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
                                {visitLabel(decodeTs(entry.went_at))}
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
                  /* Lunch stats — a read-only recap from the vote_history
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
                      {placeStatsRows.map((stat) => (
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
                          marginBottom: "8px",
                        }}
                      >
                        <cf-input
                          $value={cityDraft}
                          placeholder={`City for menu search (now: ${cityLabel})`}
                          aria-label="Poll city"
                          timing-strategy="immediate"
                          style="flex:1"
                        />
                        <cf-button onClick={boundSetCity}>Set city</cf-button>
                        <cf-button
                          variant="secondary"
                          onClick={boundEnrichHomePages}
                          title="Look up each option's official homepage and store it"
                        >
                          🔄 Refresh homepage links
                        </cf-button>
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
      city: cityLabel,
      // Output snapshots readable from OTHER runtimes (multi-user tests,
      // remote viewers): raw scoped values read as undefined in runtimes that
      // didn't write them, and a computed that RETURNS undefined is
      // indistinguishable from "not yet computed" for cross-runtime readers —
      // so every snapshot yields a real, stable value (the shared EMPTY
      // constants keep the fallback idempotent across recomputes). The visit
      // history is no longer a PerSpace input — it lives in SQLite now and is
      // surfaced via `recentVisits`/`mostRecentTitle` below.
      options: computed(() => options ?? EMPTY_OPTIONS),
      votes: liveVotes,
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
      placeStats: placeStatsRows,
      isJoined: participantIdentity.isJoined,
      isAdmin: participantIdentity.isAdmin,
      homePageLookupUrls,
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
      setCity: boundSetCity,
      enrichHomePages: boundEnrichHomePages,
      setOptionUrl: boundSetOptionUrl,
    };
  },
);
