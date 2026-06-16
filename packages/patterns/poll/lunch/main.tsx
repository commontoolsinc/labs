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
 * card surfaces per-place visit + green/red tallies from it. Live voting stays
 * on the in-cell `votes` array — only the durable record is in SQLite. Both
 * tables carry a frozen TEXT name plus a `cfLink<User>` live profile pointer.
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
  fetchData,
  generateText,
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

import {
  clearFlagConfirm,
  isFlagConfirming,
  revealFlagConfirm,
} from "../shared/confirm.tsx";
import {
  getInitials,
  newOptionId,
  trimmedName,
  VOTE_SWATCH,
} from "../shared/constants.tsx";
import type {
  AddOptionEvent,
  CastVoteEvent,
  ClaimHostEvent,
  ClearVoteEvent,
  JoinEvent,
  NameCell,
  RemoveOptionEvent,
  ResetVotesEvent,
  User,
  UsersCell,
  Vote,
  VoteColor,
  VotesCell,
} from "../shared/types.tsx";
import {
  castVote,
  clearMyVote,
  resetVotes,
  tallyOptions,
} from "../shared/voting.tsx";
import { PollOptionCard } from "./poll-option-card.tsx";
import { UserDirectoryCard } from "./user-directory-card.tsx";

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

// Cuisine illustration for each option. Only the host asks the local image
// generator for an image; the returned data URL is then stored on the shared
// option so other viewers render the host-written result.
const GENERATE_IMAGE_PATH = "/api/ai/img";
const GENERATED_IMAGE_SIZE = 128;
const WEB_SEARCH_URL = "/api/agent-tools/web-search";

interface WebSearchResponse {
  results?: Array<{ title?: string; url?: string; description?: string }>;
}

// Art-director prompt. Goals (hard-won from early results): capture the
// *essence* of the cuisine like a minimal "parti diagram" rather than a busy
// scene, and draw the FOOD — inferring the cuisine from the restaurant name
// rather than illustrating the name literally (e.g. "…Palace of Indian
// Cuisine" should yield a dish, not a palace). Kept here so the style stays
// consistent across options and is easy to tune in one place.
const cuisineArtPrompt = (title: string) =>
  "A tiny 128x128 thumbnail intended to serialize to about 10 kB. " +
  "A hand-drawn pen-and-ink illustration with visible hand-inked pen strokes " +
  "and light crosshatching, as if sketched by hand with a fountain pen, with " +
  "gentle, restrained washes of soft watercolor color — present and warm but " +
  "understated, never saturated: a single close-up " +
  "of one iconic dish that captures the essence of a cuisine. The food fills " +
  "most of the frame, cropped at the edges to emphasize the food itself. A " +
  "plate or bowl is fine but not required — show the food however best suits " +
  "the dish (on a board, wrapped, or on its own). Infer the cuisine from " +
  "this restaurant's name " +
  `and draw only the food — "${title}". One dish only, not a pair. Do not ` +
  "draw buildings, palaces, storefronts, logos, people, or text. Clean white " +
  "background, no border.";

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

type CityCell = Writable<string | Default<"Berkeley, CA">>;
type LinkTargetCell = Writable<string | null>;
type OptionsCell = Writable<Option[] | Default<[]>>;
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

const generatedImageUrlFor = (title: string): string =>
  `${GENERATE_IMAGE_PATH}?prompt=${
    encodeURIComponent(cuisineArtPrompt(title))
  }&width=${GENERATED_IMAGE_SIZE}&height=${GENERATED_IMAGE_SIZE}`;

const imageRouteUrlForOption = (
  isAdmin: boolean,
  title: string,
  storedImageUrl: string | undefined,
): string =>
  isAdmin && !safeImageUrl(storedImageUrl) ? generatedImageUrlFor(title) : "";

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

const homePageVerifierSystem =
  "You verify restaurant website search results. Choose the restaurant's own " +
  "official website only when it is clear from the candidate URL, title, and " +
  "description. Reject directories, review sites, delivery apps, reservation " +
  "sites, social media, maps, unrelated restaurants, and similarly named " +
  "businesses. Answer with exactly one candidate number, or NONE.";

const homePageVerifierPrompt = (
  title: string,
  city: string,
  refresh: number,
  candidates: WebSearchResponse["results"],
): string => {
  const rows = (candidates ?? [])
    .map((candidate, index) =>
      typeof candidate?.url === "string" && candidate.url.length > 0
        ? (
          `${index + 1}. URL: ${candidate.url}\n` +
          `   Title: ${candidate.title ?? ""}\n` +
          `   Description: ${(candidate.description ?? "").slice(0, 300)}`
        )
        : ""
    )
    .filter((row) => row !== "");
  if (rows.length === 0) return "";
  return `Restaurant: ${title}\nCity: ${city}\nRefresh: ${refresh}\n\nCandidates:\n${
    rows.join("\n")
  }\n\nReturn only the candidate number, or NONE.`;
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

// Reduce a resolved result URL to the site's homepage (root). Grounding often
// lands on a deep/junk path (e.g. `/Account/SignUp//`, `/accessibility`) even
// when the domain is right; we only want the homepage. We don't re-validate the
// root server-side — the web-search route already confirmed the domain is
// reachable, and bare-root fetches from the server are unreliable (bot blocks)
// even for sites that load fine in a browser. The clean root link is what we
// store; the browser follows any root → landing-page redirect itself.
function toHomepage(url: string): string {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
}

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
  votes: VotesCell;
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  visitDate: NameCell;
  rev: RevCell;
}>(
  (
    { optionId, title, wentAt },
    { db, options, votes, users, myName, adminName, visitDate, rev },
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
    for (const v of votes.get()) {
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
const EMPTY_VOTES: Vote[] = [];
const EMPTY_USERS: User[] = [];

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      city,
      options,
      votes,
      users,
      adminName,
      myName,
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
      db,
      options,
      votes,
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
    const userDirectory = UserDirectoryCard({ users, myName, adminName });
    const userCount = users.length;
    const optionCount = options.length;
    const voteCount = votes.length;
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
    const historyCount = computed(() => visitCount.result?.[0]?.n ?? 0);
    const hasHistory = computed(() => (visitCount.result?.[0]?.n ?? 0) > 0);
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
    // Resolve the viewer's name ONCE here at the top level. PerUser `myName`
    // resolves in this scope, but NOT inside the per-option `options.map(...)`
    // lift — there `trimmedName(myName)` was handed an unresolved ref and threw
    // `(n ?? "").trim is not a function`, silently nulling out each option's
    // `myVote` (so nothing dimmed). Passing this resolved value down avoids it.
    const me = userDirectory.me;
    // Resolve the poll's city ONCE here (same reason as `me`): the raw ref
    // doesn't resolve inside the per-option `options.map` lift where the menu
    // search query is built. Blank → Berkeley, CA.
    const cityLabel = trimmedName(city) || "Berkeley, CA";
    const searchEndpoint = trimmedName(webSearchUrl) || WEB_SEARCH_URL;
    const isJoined = userDirectory.isJoined;
    const isAdmin = userDirectory.isAdmin;
    // Hoist a boolean cell for the reset-confirm JSX ternary so TS doesn't
    // narrow `resetConfirmPending` itself and lose the `.set` method in
    // the false branch.
    const isResetConfirm = computed(() =>
      isFlagConfirming(resetConfirmPending.get())
    );
    const isClearHistoryConfirm = computed(() =>
      isFlagConfirming(clearHistoryConfirmPending.get())
    );
    const ranked = tallyOptions(options, votes, users);
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
                    const currentViewer = me;
                    const amAdmin = isAdmin;
                    // "you are the host" is handled by the HOST chip in the
                    // top right; only call out the host's name to non-admins.
                    const hostNote = !amAdmin && currentViewer !== "" &&
                        admin !== ""
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
                  const currentViewer = me;
                  if (currentViewer === "") return null;
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
                        title={currentViewer}
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
                        {currentViewer}
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
                {userDirectory}

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
                  const currentViewer = me;
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
                                  boxShadow: v.name === currentViewer
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
                  const admin = trimmedName(adminName);
                  const amAdmin = isAdmin;
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
                  // Use the top-level-resolved `me`, not `trimmedName(myName)`:
                  // the raw PerUser ref doesn't resolve inside this per-option
                  // lift (see `me` above).
                  const rank = computed(() => {
                    const idx = ranked.findIndex(
                      (t) => t.option.id === oid,
                    );
                    return idx >= 0 ? idx + 1 : 0;
                  });
                  const storedArtUrl = computed(() =>
                    safeImageUrl(option.imageUrl)
                  );
                  const generatedArt = fetchData<string>({
                    url: computed(() =>
                      imageRouteUrlForOption(
                        isAdmin,
                        option.title,
                        option.imageUrl,
                      )
                    ),
                    mode: "dataUrl",
                    options: {
                      mutexTimeoutMs: 30_000,
                    },
                  });
                  // Host persists the generated image returned by the image
                  // route as a data URL.
                  // Other viewers render the stored value without running
                  // pattern-side image generation work.
                  const artSyncState = computed(() => {
                    if (safeImageUrl(option.imageUrl)) return "stored";
                    const imageRouteUrl = imageRouteUrlForOption(
                      isAdmin,
                      option.title,
                      option.imageUrl,
                    );
                    if (!imageRouteUrl) return "";
                    const url = safeImageUrl(generatedArt.result);
                    if (url) {
                      boundSetOptionImage.send({
                        optionId: oid,
                        imageUrl: url,
                      });
                      return "stored";
                    }
                    if (generatedArt.pending) return "pending";
                    return generatedArt.error ? "error" : "requested";
                  });
                  const homePageSearch = fetchData<WebSearchResponse>({
                    url: computed(() =>
                      homePageLookupUrlFor(
                        isAdmin,
                        Number(homePageRefresh.get() ?? 0),
                        option.homePageUrl,
                        option.homePageUrlOverride,
                        searchEndpoint,
                      )
                    ),
                    mode: "json",
                    options: {
                      method: "POST",
                      mutexTimeoutMs: 30_000,
                      headers: computed(() => ({
                        "Content-Type": "application/json",
                        "X-Lunch-Poll-Refresh": String(
                          homePageRefresh.get() ?? 0,
                        ),
                      })),
                      body: computed(() => ({
                        query:
                          `official website of the restaurant "${option.title}" in ${cityLabel}`,
                        max_results: 4,
                      })),
                    },
                  });
                  const homePageVerifier = generateText({
                    system: homePageVerifierSystem,
                    prompt: computed(() => {
                      if (
                        !homePageLookupUrlFor(
                          isAdmin,
                          Number(homePageRefresh.get() ?? 0),
                          option.homePageUrl,
                          option.homePageUrlOverride,
                          searchEndpoint,
                        )
                      ) return "";
                      if (homePageSearch.pending) return "";
                      return homePageVerifierPrompt(
                        option.title,
                        cityLabel,
                        Number(homePageRefresh.get() ?? 0),
                        homePageSearch.result?.results,
                      );
                    }),
                  });
                  const fetchedHomePageUrl = computed(() => {
                    if (
                      !homePageLookupUrlFor(
                        isAdmin,
                        Number(homePageRefresh.get() ?? 0),
                        option.homePageUrl,
                        option.homePageUrlOverride,
                        searchEndpoint,
                      )
                    ) return "";
                    if (homePageSearch.pending || homePageVerifier.pending) {
                      return "";
                    }
                    const choice = Number(trimmedName(homePageVerifier.result));
                    const url = Number.isInteger(choice) && choice > 0
                      ? homePageSearch.result?.results?.[choice - 1]?.url
                      : "";
                    return typeof url === "string" && url
                      ? toHomepage(url)
                      : "";
                  });
                  const displayHomePageUrl = computed(() => {
                    const stored = trimmedName(option.homePageUrl);
                    if (stored) return stored;
                    const fetched = fetchedHomePageUrl;
                    if (fetched) {
                      boundSetOptionHomePageUrl.send({
                        optionId: oid,
                        url: fetched,
                      });
                      return fetched;
                    }
                    return "";
                  });
                  // Homepage-link enrichment. The host auto-fills missing
                  // links; the refresh button bumps a shared marker to retry.
                  // Only the host's runtime gets a fetch URL.
                  // When the verifier accepts a result, the host stores it in
                  // shared option state so every viewer sees the same link.
                  // Priority: user override > stored URL > latest verified
                  // lookup > Google Maps fallback.
                  const homeUrl = computed(() => {
                    const o = trimmedName(option.homePageUrlOverride);
                    if (o) return o;
                    const stored = trimmedName(option.homePageUrl);
                    if (stored) return stored;
                    return `https://www.google.com/maps/search/?api=1&query=${
                      encodeURIComponent(`${option.title} ${cityLabel}`)
                    }`;
                  });
                  const isEditingLink = computed(() =>
                    linkEditTarget.get() === option.id
                  );
                  const homeLabel = computed(() => {
                    if (trimmedName(option.homePageUrlOverride)) {
                      return "🔗 Website (edited)";
                    }
                    return trimmedName(option.homePageUrl)
                      ? "🔗 Website"
                      : "🔎 Find on Maps";
                  });
                  return PollOptionCard({
                    option,
                    rank,
                    me,
                    isJoined,
                    isAdmin,
                    votes,
                    removeConfirmTarget,
                    linkEditTarget,
                    linkDraft,
                    artUrl: storedArtUrl,
                    artSyncState,
                    displayHomePageUrl,
                    homeUrl,
                    homeLabel,
                    isEditingLink,
                    castVote: boundCastVote,
                    removeOption: boundRemoveOption,
                    logVisit: boundLogVisit,
                    setOptionUrl: boundSetOptionUrl,
                  });
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
                                    clearFlagConfirm(
                                      clearHistoryConfirmPending,
                                    );
                                  }}
                                >
                                  Clear all
                                </cf-button>
                                <cf-button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    clearFlagConfirm(
                                      clearHistoryConfirmPending,
                                    )}
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
                                  revealFlagConfirm(
                                    clearHistoryConfirmPending,
                                  )}
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
                                  clearFlagConfirm(resetConfirmPending);
                                }}
                              >
                                Yes, reset
                              </cf-button>
                              <cf-button
                                variant="ghost"
                                onClick={() =>
                                  clearFlagConfirm(resetConfirmPending)}
                              >
                                Cancel
                              </cf-button>
                            </>
                          )
                          : (
                            <cf-button
                              onClick={() =>
                                revealFlagConfirm(resetConfirmPending)}
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
      votes: computed(() => votes ?? EMPTY_VOTES),
      users: computed(() => users ?? EMPTY_USERS),
      adminName: computed(() => trimmedName(adminName)),
      myName: computed(() => me),
      userCount,
      optionCount,
      voteCount,
      historyCount,
      recentVisits,
      mostRecentTitle,
      voteHistoryCount,
      placeStats: placeStatsRows,
      isJoined,
      isAdmin,
      homePageLookupUrls,
      joinAs: userDirectory.joinAs,
      claimHost: userDirectory.claimHost,
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
