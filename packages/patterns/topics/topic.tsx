import {
  action,
  cellFromUrl,
  type ComparableCell,
  Default,
  equals,
  handler,
  lift,
  NAME,
  pattern,
  type PerSession,
  type ReadonlyCell,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// ===== Shared types =====

/**
 * What a link points at — a rendering hint, not a behavior switch.
 *
 * An open domain rather than an enum, deliberately. This value is PROVIDED
 * data: it reaches a reader through a published result, where the update gate
 * requires the new type to be a subset of the old one. A closed enum there can
 * never gain a member, so declaring one is a promise never to learn a new kind
 * of link — and the set below is a guess about a corpus that keeps growing.
 *
 * Well-known values, which the composer offers and the renderer styles:
 * `"web"`, `"pr"`, `"topic"`, `"session"`. Anything else stores and renders as
 * itself rather than being refused.
 */
export type TopicLinkKind = string;

/** A display snapshot attached atomically to content. Fabric remains the
 * authority for which principal/key performed the write. `kind: "agent"`
 * disambiguates an agent acting with its human user's key. */
export interface TopicAuthor {
  /** Open for the same reason `TopicLinkKind` is: this is provided data, so a
   * closed set here could never gain `"service"` or whatever acts next.
   * Well-known values are `"person"` and `"agent"`, the latter marking an
   * agent acting with its human user's key. */
  kind: string;
  name: string;
  avatar?: string;
}

export interface AgentAuthoredEvent {
  /** Explicit content-level signature for an agent using its human user's
   * identity key. Fabric authenticates the write with that key; this says
   * which agent acted under it.
   *
   * Required, and required from the start of a caller's life rather than
   * eventually: acceptance can widen later but not narrow, so a verb that
   * tolerates an unsigned call can never stop tolerating one without a break.
   * Taking it here means the arrival of execution provenance can relax this
   * to optional compatibly, which is the direction that costs nothing. */
  agentName: string;
}

export interface AddCommentEvent extends AgentAuthoredEvent {
  /** The comment text, appended verbatim after trimming. Must be non-empty:
   * an empty body rejects rather than recording a blank thread entry. */
  body: string;
}

export interface AddLinkEvent extends AgentAuthoredEvent {
  /** What the link points at — a rendering hint, not a behavior switch.
   * Optional because the handler defaults it to `"web"`, and a caller should
   * not be made to supply a field the verb never needed. */
  kind?: TopicLinkKind;

  /** The link target. Must be http(s): anything else rejects, because a
   * user-supplied scheme on a shared surface is script execution in every
   * viewer's session. */
  url: string;

  /** Display label. Optional, and a blank one falls back to the URL — the
   * handler has always done that, and requiring the field only kept callers
   * from relying on it. */
  label?: string;
}

export interface SetBodyEvent extends AgentAuthoredEvent {
  /** The complete replacement body, persisted verbatim — no trimming, so
   * whitespace-sensitive Markdown survives. An empty body is legal: clearing
   * a living document is an edit, not an error. */
  body: string;
}

export interface SetTitleEvent {
  /** The new title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The agent making this mutation, stored as structured attribution beside
   * the write time. Required: this verb postdates the unsigned-caller era,
   * so it carries no legacy fallback. */
  agentName: string;
}

/**
 * Reference another piece from this topic.
 *
 * Carries no `agentName`, unlike every other verb here, and the absence is the
 * honest one: a mention records where a reference points and nothing about who
 * made it, so a signature would be accepted and then dropped. Fabric still has
 * the principal that made the write.
 */
export interface MentionEvent {
  /** The piece to reference — the piece itself, not an address. Identity here
   * is the cell, so this is what a caller passes and what gets stored.
   *
   * Declared through the ONE field every topic has rather than `unknown`, and
   * the narrowness is what makes a non-reference CHEAP TO CATCH — not what
   * catches it. An `asCell` payload is wrapped whole without validating what
   * is behind it, so naming a property refuses nothing at the boundary: an
   * address sent as text, which an inline CLI call argument produces by being
   * parsed as plain JSON, arrives here as readily as a piece does. What the
   * named property buys is a one-field read that tells the two apart —
   * `topic.get()` is `undefined` for a value that is not a reference and an
   * object for any piece — and `mention` spends it before storing anything.
   *
   * `title` is also the most this can safely name: this schema reaches every
   * topic in `mentionable`, so a property without a default would be demanded
   * of topics written before it existed and refuse their update. `title`
   * carries one, and that default does double duty — it is also why the check
   * admits a piece that is not a topic at all, which reads back `{ title: "" }`
   * rather than `undefined`. `deno task pattern-vintage` proves the update side
   * by replaying a real board.
   *
   * Nothing reads THROUGH it beyond that one field — the value is stored and
   * compared. */
  topic: Writable<{ title: string | Default<""> }>;
}

/** Stop referencing a piece. */
export interface UnmentionEvent {
  /** Declared and checked exactly as `MentionEvent.topic` is, and for the same
   * reason: a payload that is not a reference matches no stored entry, so
   * without the check it would remove nothing and report success. */
  topic: Writable<{ title: string | Default<""> }>;
}

// ===== Verb results =====
//
// Each mutating verb returns exactly what it recorded, so a caller learns the
// outcome from the call instead of following it with a verification read. The
// records carry the fields the pattern resolved — the structured author it
// derived from `agentName`, and the write-time timestamp — which a caller
// cannot compute for itself. Counts are deliberately absent: every append here
// is a mergeable op, so a length observed inside one handling is not a fact
// about the resulting list.

export interface AddCommentResult {
  /** The comment as appended, including resolved author and `sentAt`. */
  comment: TopicComment;
}

export interface AddLinkResult {
  /** The link as appended, including resolved `addedBy` and `addedAt`. */
  link: TopicLink;
}

export interface SetBodyResult {
  /** The body as persisted — verbatim, so a caller can confirm that
   * whitespace-sensitive Markdown survived the round trip. */
  body: string;

  /** Attribution written for this save. Both are absent when the caller sent
   * no `agentName`: an unattributed save leaves the previous attribution
   * standing rather than overwriting it. */
  bodyUpdatedBy?: TopicAuthor;
  bodyUpdatedAt?: number;
}

export interface SetTitleResult {
  /** The title as persisted, after trimming. */
  title: string;

  /** Attribution written for this rename — always present, because the verb
   * requires `agentName`. */
  titleUpdatedBy: TopicAuthor;
  titleUpdatedAt: number;
}

export interface TopicComment {
  /** Snapshot taken at write time (profile enrichment comes later; never gate
   * authorship on a profile wish — CT-1879). Comments carry no minted id:
   * array elements have stable entity identity; future editing addresses
   * elements by reference (`equals()`), not by a synthetic key.
   *
   * Every comment written from now on carries one, because `addComment`
   * requires a signature. Still OPTIONAL, and that is not a hedge: a comment
   * stored by the unsigned path has no author, and a stored record type has to
   * accept what is already stored. Requiring it here does not make old comments
   * signed — it makes a deployed piece holding one impossible to update at all,
   * which `deno task pattern-vintage` refuses rather than discovers in
   * production. */
  author?: TopicAuthor;
  body: string | Default<"">;
  sentAt: number | Default<0>;
}

export interface TopicLink {
  kind: TopicLinkKind | Default<"web">;
  url: string | Default<"">;
  label: string | Default<"">;
  addedBy?: TopicAuthor;
  addedAt?: number;
}

export interface TopicInput {
  title?: Writable<string | Default<"">>;

  /** The topic's living document: durable conclusions get folded up into the
   * body; the comment thread below holds the deliberation. */
  body?: Writable<string | Default<"">>;
  comments?: Writable<TopicComment[] | Default<[]>>;
  links?: Writable<TopicLink[] | Default<[]>>;
  createdAt?: number | Default<0>;
  createdBy?: TopicAuthor;
  bodyUpdatedBy?: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  bodyUpdatedAt?: Writable<number | Default<0>>;

  /** Attribution of the last rename, stamped by `setTitle` — the same pair
   * the body keeps, because a title is the other editable scalar. */
  titleUpdatedBy?: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  titleUpdatedAt?: Writable<number | Default<0>>;

  /** The board's own topics list — the mention universe the body editor
   * autocompletes over. A reference to the tracker's array, wired at creation
   * like `myName` (and backfillable as a one-time link-bind on pieces created
   * before it existed). Absent, the editor simply offers no completions. */
  mentionable?: Writable<TopicMentionable[] | Default<[]>>;

  /** Where this topic's `[Label][key]` mentions point, keyed by the token that
   * appears in the body. The editor owns the contents; this pattern owns the
   * cell, which is what makes a mention durable and — because each entry holds
   * the destination as a REFERENCE — what makes the reference graph a question
   * about cell identity rather than about text.
   *
   * The default has to match the one `TopicOutput` publishes. A map published
   * under a different default than its input carries cannot be materialized. */
  // deno-lint-ignore ban-types
  references?: Writable<TopicMentionRefMap | Default<{}>>;

  /** Pieces this topic references outside its prose — what `mention` records.
   *
   * Its own list rather than an entry in `references`, because that map belongs
   * to the body editor: the editor mints its keys, rewrites its labels, and
   * collects entries whose token has left the document. A verb writing there
   * would be writing into somebody else's bookkeeping. Here there is nothing to
   * key by, because there is nothing to point back at from the prose — a
   * reference outside a sentence is just a link in a list. */
  mentioned?: Writable<unknown[] | Default<[]>>;

  /** The board's mention pivot, one row per topic. A topic reads its own row
   * out of it and nothing else; see `backlinksOf`. Absent, a topic simply shows
   * no inbound references.
   *
   * Readable, not writable: the pivot is the board's derivation, and a topic
   * has no business writing into it. Declaring the narrower cell says so where
   * a reader can see it, rather than leaving it to convention. */
  boardCrossrefs?: ReadonlyCell<TopicCrossrefRow[] | Default<[]>>;
}

/**
 * One `[Label][key]` mention: where it points, and whether the reader has given
 * it a wording of their own.
 *
 * `destination` is `unknown` because a mention may address any piece, and
 * because that is the declaration that keeps it a reference. Every consumer
 * here compares it by identity — nothing reads through it — so nothing needs
 * a wider type, and a wider type would start expanding the piece behind it.
 *
 * The shape is the `cf-code-editor` `$references` contract
 * (`packages/ui/src/v2/core/mention-refs.ts`), which notes carries too.
 */
export interface TopicMentionRef {
  destination: unknown;
  modifiedTitle: boolean;
}

/** A topic's mentions, keyed by the token that appears in its body. The keys
 * are local to one topic and mean nothing anywhere else. */
export type TopicMentionRefMap = Record<string, TopicMentionRef>;

/**
 * What the board's pivot reads from one topic: what it points at, and nothing
 * else. This is the entire cost of deriving the whole graph.
 *
 * The mentions are CELLS, and the annotation is what makes the answer settle.
 * Declared `unknown` each entry still arrives as a link — the proxy keeps the
 * back-pointer, and `equals` compares it correctly every time — but nothing
 * tells the runtime that the entry is a reference worth tracking, so whether
 * the document behind it has loaded when this runs is a matter of timing. The
 * pivot then computes a different graph on different passes and never
 * converges: the row for a topic that IS mentioned comes back empty, and the
 * idempotency recheck reports differing writes for `mentionedBy`.
 *
 * `ComparableCell` is that missing annotation. It does not change what an entry
 * is, only what the runtime knows to do about it, which is the whole difference
 * between a graph that settles and one that depends on load order.
 */
export interface TopicMentionSource {
  mentions: ComparableCell<unknown>[] | Default<[]>;
}

/**
 * One row of the board's mention pivot: a topic, and the topics that mention
 * it.
 *
 * ONE ROW PER DISTINCT TOPIC. That is the contract, not a property of the
 * board that happens to hold: a row is addressed by `Writable.for(topic)`, so
 * a board listing the same topic twice addresses ONE row from both entries and
 * the second write lands on the first. Set semantics by construction — nothing
 * downstream dedupes, and a reader finding its row by identity finds exactly
 * one. The pivot's self-skip is asked of the topic rather than of its position
 * so that a duplicate entry stays inert here too.
 *
 * Both sides are declared `unknown`, which is the whole design rather than a
 * shortcut. A row holds cell REFERENCES — `unknown` is the declaration that
 * lets a cell be written into one without a cast, and the one that stops any
 * reader of the table expanding a topic it did not ask for. Each consumer
 * declares what it wants to see through them.
 */
export interface TopicCrossrefRow {
  /** The topic this row is about. `unknown` because it is written as a
   * reference and only ever compared — `equals` takes the raw link. Anything
   * wider retrieves the piece instead of pointing at it: declared `object`,
   * this field reads back as the whole expanded topic, `$UI` tree included. */
  topic: unknown;
  mentionedBy: unknown[];
}

/**
 * What the body editor's `@`-mention autocomplete needs of a sibling: the
 * display name it lists, and the title it matches on.
 *
 * `[NAME]` is not decoration here. `cf-code-editor` declares its entries as
 * `Mentionable`, whose schema carries `required: [NAME]`
 * (`packages/ui/src/v2/core/mentionable.ts`), so a sibling projection without
 * it silently offers no completions — the JSX prop binding is loose enough
 * that TypeScript does not object.
 */
export interface TopicMentionable {
  [NAME]: string | Default<""> | undefined;
  title: string | Default<"">;
}

/**
 * The least a board row needs from a topic: its title, and the scalars a
 * full-board survey summarizes.
 *
 * An input projection, not a published type — every reference this pattern
 * publishes is declared at `TopicPiece`. Keeping it out of the published
 * surface is what leaves it free to shrink.
 */
export interface TopicSummary {
  /** The topic's title. Defaulted rather than required, like every other
   * field a board card renders: the card list is a mapped sub-pattern, so
   * this type reaches a piece holding topics written before the field
   * existed as the argument schema its update is checked against, and a
   * required property those topics lack refuses that update outright.
   * `deno task pattern-vintage` is what catches it, by replaying a real
   * deployed board. */
  title: string | Default<"">;

  /** When the topic was filed (epoch milliseconds), stamped at create. */
  createdAt: number;
  createdBy?:
    | TopicAuthor
    | Default<{ kind: "person"; name: "" }>
    | undefined;
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
}

/**
 * A #topic — a durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, and typed links out to other
 * core objects (PRs, agent sessions, other topics). Deliberately has no
 * status, labels, or assignees; what a topic grows next is part of the
 * experiment (CT-1878).
 *
 * This is the board-facing projection: the one stored in the tracker's list,
 * and the one a topic's editor autocompletes over through `mentionable`.
 * Session-local UI controls are intentionally excluded: a TopicPiece can be
 * followed from a shared list even when the viewer has no matching
 * session-local cells.
 */
export interface TopicPiece extends TopicSummary {
  /** The topic's display name. Like the other derived display fields, a cold
   * retained topic may not have produced this path yet; its persisted title
   * remains authoritative until it does. */
  [NAME]: string | Default<""> | undefined;

  /** The living document, verbatim Markdown. `setBody` replaces it whole. */
  body: string | Default<"">;

  /** The thread, in arrival order: append-only point-in-time records, each
   * carrying its author snapshot and `sentAt`. */
  comments: TopicComment[];

  /** Typed outbound links, in arrival order, each carrying its author
   * snapshot and `addedAt`. */
  links: TopicLink[];

  /** Every piece this topic's prose and links point at, as references.
   *
   * The board's pivot is declared over this and nothing else, so what one topic
   * costs a full-board scan is exactly this list of identities. Declared
   * `unknown[]` because these are references, and comparing them never reads
   * what is behind them.
   *
   * The cell annotation that makes them comparable belongs to the READER, not
   * here: the pivot declares its own view of this list as
   * `TopicMentionSource.mentions: ComparableCell<unknown>[]`, and that is what
   * makes its graph settle rather than depend on load order. A published
   * `unknown[]` is what each reader annotates for itself.
   *
   * The default stands alone: a declared default and `| undefined` collide,
   * and the default is what a topic deployed before this path existed
   * materializes against. */
  mentions: unknown[] | Default<[]>;

  /** Where this topic's `[Label][key]` mentions point. Durable content, like
   * `links`. The body editor works on a session copy of this map, which a save
   * publishes here whole, beside the prose whose tokens name its entries. */
  // deno-lint-ignore ban-types
  references: TopicMentionRefMap | Default<{}>;

  /** Pieces referenced outside the prose, recorded by `mention`. */
  mentioned: unknown[] | Default<[]>;

  /** The topics that mention this one, read out of the board's pivot.
   *
   * Declared through `TopicSummary` rather than `TopicPiece`, and that is
   * load-bearing rather than stingy: a topic whose backlinks were topics would
   * be a type that contains itself, and resolving one from a list would walk
   * the graph. The summary carries no reference of its own, so it terminates.
   * A reader that wants more follows the link, which resolves whole. */
  referencedBy: TopicSummary[] | Default<[]>;
  bodyUpdatedBy?: TopicAuthor | undefined;
  bodyUpdatedAt?: number | undefined;

  /** Append to the thread — a point-in-time record of progress or
   * deliberation; durable conclusions belong in the body. Returns the
   * comment as recorded, resolved author and `sentAt` included. */
  addComment: Stream<AddCommentEvent, AddCommentResult>;

  /** Attach a typed outbound link — a PR, an agent session, a web page.
   * Returns the link as recorded, resolved `addedBy` and `addedAt`
   * included. Appends merge and nothing dedupes: a repeated URL is two
   * entries. */
  addLink: Stream<AddLinkEvent, AddLinkResult>;

  /** Replace the living document whole — read it, revise it, write it back
   * complete; the body is one value with whole-value conflict semantics.
   * Returns the persisted body and any attribution written. */
  setBody: Stream<SetBodyEvent, SetBodyResult>;

  /** Reference another piece from this topic — the payload is the piece
   * itself, stored as a reference. The browser equivalent is picking a
   * completion in the body editor, which writes the same map.
   *
   * Required, like the verbs beside them. They were optional because a topic
   * deployed before they existed carries neither, and a required property a
   * piece cannot produce refuses its update — but an optional verb is its own
   * defect: it pushes a maybe to every call site whose obvious spelling,
   * `piece.verb?.send(...)`, skips in silence rather than failing. This change
   * is already a rehearsed break that rewrites every topic, so the generation
   * that lacked them does not survive it, and the reason for the optionality
   * goes with it. */
  mention: Stream<MentionEvent>;

  /** Stop referencing a piece: removes every `mention`-made entry naming it.
   * References made in the prose are retracted by editing the prose, not by
   * this. Optional on the projection for the same reason as `mention`. */
  unmention: Stream<UnmentionEvent>;
}

/**
 * A #topic — one durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, typed links out to other
 * core objects (PRs, agent sessions, web pages), and the references it makes
 * to sibling pieces.
 *
 * Durable conclusions get folded up into the body — revise it whole with
 * `setBody`; the thread holds the deliberation as append-only, point-in-time
 * `addComment` records. Sign every mutation with `agentName`: Fabric records
 * the human principal behind the key; the name says which agent acted under
 * it. The session-draft cells and `submit*` streams below belong to the
 * rendered page, not the headless contract — they read state only this
 * session holds.
 */
export interface TopicOutput extends TopicPiece {
  [UI]: VNode;

  /**
   * Session-local composer/edit state. These controls belong to a direct Topic
   * instance, not the shared TopicPiece projection used by the tracker's list.
   */
  commentDraft: PerSession<Writable<string>>;
  bodyDraft: PerSession<Writable<string>>;
  editingBody: PerSession<boolean>;
  titleDraft: PerSession<Writable<string>>;
  editingTitle: PerSession<boolean>;
  linkUrlDraft: PerSession<Writable<string>>;
  linkLabelDraft: PerSession<Writable<string>>;
  linkKindDraft: PerSession<Writable<TopicLinkKind>>;

  /**
   * The body draft's mention map, staged so Cancel can discard it.
   *
   * `cf-code-editor` writes an entry the moment a mention is inserted and
   * drops one the moment its token leaves the document, neither of them
   * waiting for Save. Pointed at the durable map while `$value` holds a
   * session draft, those writes would outlive a discarded edit: a canceled
   * insertion would leave an edge no token names, and a canceled deletion
   * would strip the destination from a token the durable body still carries.
   * The editor's own ordering assumes its two bindings share a lifetime, so
   * this gives them one.
   */
  referencesDraft: PerSession<Writable<TopicMentionRefMap>>;

  /** Rename the topic. Lives on the direct interface rather than the shared
   * `TopicPiece` projection, and the placement is the contract: a holder's
   * required demands are write-once, so a required verb added to the
   * projection every board embeds would refuse those boards' updates.
   * (`mention` above takes the other safe road, an optional member; a rename
   * is a direct-address mutation and needs no place on the projection at
   * all.) Requires `agentName` and returns the persisted title with the
   * attribution written. */
  setTitle: Stream<SetTitleEvent, SetTitleResult>;

  /** Attribution of the last rename; unset until the first `setTitle`.
   * Beside `setTitle` rather than on the projection, for the same reason. */
  titleUpdatedBy?: TopicAuthor | undefined;
  titleUpdatedAt?: number | undefined;

  /** UI wrapper: open the rename editor, seeding the session draft from the
   * durable title. */
  startEditTitle: Stream<void>;

  /** UI wrapper: save the session title draft under the viewer's Profile —
   * the contract verb is `setTitle`, and both land through the same core, so
   * a browser rename stamps the same attribution and moves the same activity
   * clock. */
  saveTitle: Stream<void>;

  /** UI wrapper: close the rename editor; the session draft is the discard. */
  cancelEditTitle: Stream<void>;

  /** UI wrapper: append the session comment draft under the viewer's
   * Profile. Reads session-local state, so it is a silent no-op headless —
   * the contract verb is `addComment`. */
  submitComment: Stream<void>;

  /** UI wrapper: open the body editor, seeding the session drafts from the
   * durable body and mention map. */
  startEditBody: Stream<void>;

  /** UI wrapper: publish the session body and mention-map drafts whole,
   * attributed to the viewer's Profile — the contract verb is `setBody`. */
  saveBody: Stream<void>;

  /** UI wrapper: close the body editor; the session drafts are the discard. */
  cancelEditBody: Stream<void>;

  /** UI wrapper: append the session link drafts under the viewer's Profile —
   * the contract verb is `addLink`. */
  submitLink: Stream<void>;
}

// ===== Shared theme (calm editorial light) =====

export const TOPICS_THEME = {
  fontFamily: "'Iowan Old Style', 'Palatino', 'Georgia', serif",
  borderRadius: "0.5rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#31572c",
    primaryForeground: "#fdfcf8",
    background: "#fdfcf8",
    surface: "#f6f3ea",
    text: "#26241f",
    textMuted: "#7d7767",
    border: "#e4dfd1",
    accent: "#a4531f",
    accentForeground: "#fdfcf8",
  },
};

// ===== Pure helpers =====

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Label derived purely from the stored timestamp — never from the current
 * clock — so it stays idempotent inside computeds (lunch-poll idiom). */
export const whenLabel = (ts: number): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
};

export const snippet = (text: string, max: number): string => {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Build the content-level signature required by headless mutation streams.
 * The authenticated human principal is deliberately not copied here: Fabric
 * already owns that authority and history. */
export const topicAuthorFromAgent = (
  agentName: string,
): TopicAuthor | undefined => {
  const name = (agentName ?? "").trim();
  return name ? { kind: "agent", name } : undefined;
};

/** Snapshot the canonical Profile fields used by browser mutations. */
export const topicAuthorFromPerson = (
  profileName: string,
  profileAvatar = "",
): TopicAuthor | undefined => {
  const name = (profileName ?? "").trim();
  if (!name) return undefined;
  const avatar = (profileAvatar ?? "").trim();
  return avatar ? { kind: "person", name, avatar } : { kind: "person", name };
};

/** Reject a mutation loudly. To a headless caller a silent early-return is
 * indistinguishable from success (verb contract rule 4,
 * docs/plans/pattern-verb-contract.md); a throw surfaces as a failed handler
 * transaction and a nonzero CLI exit. Stable error codes arrive with the
 * invocation protocol; until then the message carries a stable
 * "<verb> rejected:" prefix. UI composer wrappers keep their silent guards —
 * an empty draft is a non-event in a composer. */
export const rejectMutation = (verb: string, reason: string): never => {
  throw new Error(`${verb} rejected: ${reason}`);
};

/** Structured author first, legacy string second. Agent snapshots are labelled
 * explicitly because they share the authenticated principal's identity key. */
export const topicAuthorLabel = (
  author: TopicAuthor | undefined,
): string => {
  const name = (author?.name ?? "").trim() || "someone";
  return author?.kind === "agent" ? `${name} (agent)` : name;
};

/** Only http(s) URLs may become live anchors — a user-supplied `javascript:`
 * href on a shared surface is script execution in every viewer's session.
 * Enforced at write (addLink rejects) AND at render (non-http renders as
 * text), since stored data may predate the write guard. */
export const isSafeLinkUrl = (url: string): boolean =>
  /^https?:\/\//i.test((url ?? "").trim());

const LINK_KIND_ITEMS = [
  { label: "Web", value: "web" },
  { label: "PR", value: "pr" },
  { label: "Topic", value: "topic" },
  { label: "Agent session", value: "session" },
];

/** The one place a comment record is built and appended. The contract verb
 * and the browser composer both ride it, so the trim rule, the legacy-name
 * mirror, and the write-time stamp cannot drift between them. Callers guard
 * emptiness on their own terms first — the verb rejects, the composer
 * silently declines. Mergeable append: concurrent comments all land. */
export const appendComment = (
  comments: Writable<TopicComment[] | Default<[]>>,
  body: string,
  author: TopicAuthor,
): TopicComment => {
  const comment = {
    author,
    body: body.trim(),
    sentAt: Date.now(),
  };
  comments.push(comment);
  return comment;
};

/** The one place a link record is built and appended, for the same reason as
 * `appendComment`: the kind default, the label-falls-back-to-URL rule, and
 * the write-time stamp live here and nowhere else. URL safety stays with the
 * callers — the verb rejects an unsafe URL, the composer declines it. */
export const appendLink = (
  links: Writable<TopicLink[] | Default<[]>>,
  url: string,
  kind: TopicLinkKind | undefined,
  label: string | undefined,
  author: TopicAuthor | undefined,
): TopicLink => {
  const trimmedUrl = url.trim();
  const link = {
    kind: kind ?? ("web" as const),
    url: trimmedUrl,
    label: (label ?? "").trim() || trimmedUrl,
    addedBy: author,
    addedAt: Date.now(),
  };
  links.push(link);
  return link;
};

/** Browser comment submit with Profile fields already resolved by the pattern.
 * Keeping the mutation in a module-scope handler lets tests bind deterministic
 * Profile snapshots while production still sources them only from wishes. */
export const submitProfileComment = handler<void, {
  comments: Writable<TopicComment[] | Default<[]>>;
  commentDraft: Writable<string>;
  profileName: string;
  profileAvatar: string;
}>((_, { comments, commentDraft, profileName, profileAvatar }) => {
  const text = commentDraft.get();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!text.trim() || !author) return;
  appendComment(comments, text, author);
  commentDraft.set("");
});

/** The one place a rename lands. The contract verb and the browser save both
 * ride it, so the trim rule, the attribution stamp, and the activity clock
 * move together — a title write without its attribution pair is exactly the
 * stale-metadata state this rules out, since `titleUpdatedBy` would keep
 * describing an earlier rename. Callers guard emptiness and resolve their
 * author first. */
export const persistTitle = (
  title: Writable<string | Default<"">>,
  titleUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >,
  titleUpdatedAt: Writable<number | Default<0>>,
  text: string,
  author: TopicAuthor,
): SetTitleResult => {
  const trimmed = text.trim();
  title.set(trimmed);
  const at = Date.now();
  titleUpdatedBy.set(author);
  titleUpdatedAt.set(at);
  return { title: trimmed, titleUpdatedBy: author, titleUpdatedAt: at };
};

/** Browser title save under the current Profile snapshot. The header binds a
 * session draft, never the durable title: a live-bound shared string would
 * conflict per keystroke, and a title write outside `persistTitle` would
 * leave `titleUpdatedBy` and the activity clock describing an earlier
 * rename. */
export const saveProfileTitle = handler<void, {
  title: Writable<string | Default<"">>;
  titleDraft: Writable<string>;
  editingTitle: Writable<boolean>;
  titleUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  titleUpdatedAt: Writable<number | Default<0>>;
  profileName: string;
  profileAvatar: string;
}>((
  _,
  {
    title,
    titleDraft,
    editingTitle,
    titleUpdatedBy,
    titleUpdatedAt,
    profileName,
    profileAvatar,
  },
) => {
  const text = titleDraft.get();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!text.trim() || !author) return;
  persistTitle(title, titleUpdatedBy, titleUpdatedAt, text, author);
  editingTitle.set(false);
});

/** Browser body save under the current Profile snapshot. */
export const saveProfileBody = handler<void, {
  body: Writable<string | Default<"">>;
  bodyDraft: Writable<string>;
  // deno-lint-ignore ban-types
  references: Writable<TopicMentionRefMap | Default<{}>>;
  referencesDraft: Writable<TopicMentionRefMap>;
  editingBody: Writable<boolean>;
  bodyUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  bodyUpdatedAt: Writable<number | Default<0>>;
  profileName: string;
  profileAvatar: string;
}>((
  _,
  {
    body,
    bodyDraft,
    references,
    referencesDraft,
    editingBody,
    bodyUpdatedBy,
    bodyUpdatedAt,
    profileName,
    profileAvatar,
  },
) => {
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!author) return;
  // One whole-value set per explicit save keeps the conflict window small; a
  // live-bound textarea on a shared string would conflict per keystroke.
  body.set(bodyDraft.get());
  // The map publishes with the prose it describes, in this one transaction:
  // the tokens and the destinations they name are one document, and a save
  // that landed only half of it would leave a dead link either way. Whole-map,
  // for the same reason the body above is whole-value — an entry belongs to
  // the draft that minted it, and the two conflict as one document or not at
  // all. `destination` is `unknown`, which is what carries each one across as
  // a link rather than expanding the piece behind it.
  references.set(referencesDraft.get());
  bodyUpdatedBy.set(author);
  bodyUpdatedAt.set(Date.now());
  editingBody.set(false);
});

/**
 * Drop one verb-made reference from the browser.
 *
 * A handler rather than an inline closure because the card renders one control
 * per entry, and each has to carry the piece it removes. Retracting is
 * `removeByValue` here for the same reason it is in `unmention`: it resolves
 * against durable state instead of rewriting the list.
 */
export const dropMention = handler<void, {
  mentioned: Writable<unknown[] | Default<[]>>;
  // A CELL, because `removeByValue` matches a cell by its link. Bound as a
  // plain value it would arrive resolved, match nothing, and remove nothing.
  topic: Writable<unknown>;
}>((_, { mentioned, topic }) => {
  if (!topic) return;
  mentioned.removeByValue(topic);
});

/** Browser link submit under the current Profile snapshot. */
export const submitProfileLink = handler<void, {
  links: Writable<TopicLink[] | Default<[]>>;
  linkUrlDraft: Writable<string>;
  linkLabelDraft: Writable<string>;
  linkKindDraft: Writable<TopicLinkKind>;
  profileName: string;
  profileAvatar: string;
}>((
  _,
  {
    links,
    linkUrlDraft,
    linkLabelDraft,
    linkKindDraft,
    profileName,
    profileAvatar,
  },
) => {
  const url = linkUrlDraft.get();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!url.trim() || !isSafeLinkUrl(url) || !author) return;
  appendLink(links, url, linkKindDraft.get(), linkLabelDraft.get(), author);
  linkUrlDraft.set("");
  linkLabelDraft.set("");
  linkKindDraft.set("web");
});

// ===== Derivations =====
//
// Each of these is a module-scope `lift` rather than a pattern-body derivation
// for one reason: the declared parameter type is what bounds the read. An
// inferred input schema falls back to reading its input whole, while a `lift`'s
// declared parameter is a ceiling that no opaque helper in its body can widen.

/**
 * This topic's INBOUND references: its own row of the board's pivot.
 *
 * The board has already done the join, so this is a lookup, and it is written
 * as one — find the row whose `topic` is this piece, hand back its
 * `mentionedBy`. Nothing else about the table is touched.
 *
 * It re-runs whenever any row changes, which at board scale is often. That is
 * fine, and deliberately so: the rows are addressed by the topic each describes
 * rather than by position, so a re-run over an unchanged board recomputes the
 * same links and writes nothing. What would make it expensive is reading
 * through the references, which is why the parameter declares them `unknown`:
 * `topic` is compared by identity and `mentionedBy` is passed through as links,
 * so surveying the whole table expands no topic at all.
 *
 * HACK, as elsewhere in this pattern: reads `unknown[]`, publishes
 * `TopicSummary[]`. A reference through a lift is a link and resolves to the
 * whole topic however little the lift declared, so the assertion states what a
 * consumer receives while the narrow parameter bounds what this reads.
 */
const backlinksOf = lift((
  { table, self }: {
    table:
      | { topic: ComparableCell<unknown>; mentionedBy: unknown[] }[]
      | Default<[]>;
    self: ComparableCell<unknown>;
  },
): TopicSummary[] =>
  // `filter` + `flatMap` rather than `find`, so a topic with no row on the
  // table — no board wired in — yields an empty array from the shape of the
  // expression instead of from a `?? []` bolted onto a miss. At most one row
  // matches: rows are keyed by the topic they describe.
  table
    .filter((row) => equals(self, row.topic))
    .flatMap((row) => row.mentionedBy) as TopicSummary[]
);

/**
 * Every piece this topic points at, from both places a reference can come from:
 * the body editor's mention map, and a link whose URL names a piece.
 *
 * The two arrive already resolved — the editor mints a mention as a reference,
 * and `cellFromUrl` answers a link's URL with the cell it names. So this only
 * concatenates, and the parameter says as much: `destination` and the resolved
 * cells are `unknown`, compared by identity and never read through.
 *
 * A URL naming no piece resolves with no cell, which is how an ordinary web
 * link stays an ordinary web link.
 */
const mentionsOf = lift((
  { references, mentioned, linkTargets }: {
    // deno-lint-ignore ban-types
    references: Record<string, { destination: unknown }> | Default<{}>;
    mentioned: unknown[] | Default<[]>;
    linkTargets: { cell?: unknown; pending?: boolean }[] | Default<[]>;
  },
): unknown[] =>
  [
    // Three places a reference can come from, and only the last two are this
    // pattern's to write: the body editor's map, the `mention` verb's list,
    // and a link whose URL named a piece.
    ...Object.values(references).map((ref) => ref?.destination),
    ...mentioned,
    ...linkTargets.map((resolution) => resolution?.cell),
  ].filter((destination) => destination !== undefined && destination !== null)
);

/** Max of creation, the newest comment, the newest link, the last body save,
 * and the last rename — declared over just those five timestamp surfaces. */
const lastActivityOf = lift((
  { comments, links, createdAt, bodyUpdatedAt, titleUpdatedAt }: {
    comments: { sentAt: number }[];
    links: { addedAt?: number }[];
    createdAt: number;
    bodyUpdatedAt: number;
    titleUpdatedAt: number;
  },
): number => {
  let newest = Math.max(createdAt, bodyUpdatedAt, titleUpdatedAt);
  for (const c of comments) newest = Math.max(newest, c.sentAt);
  // `addedAt` is optional on TopicLink: links written before it existed carry
  // no timestamp and simply do not move the clock.
  for (const l of links) newest = Math.max(newest, l.addedAt ?? 0);
  return newest;
});

/** The structured author, projected rather than returned as a dangling link to
 * an absent optional input path, so a sibling Topic's schema can validate the
 * piece. A topic with no author reads as the inert sentinel rather than as
 * nothing. */
const createdByOf = lift((
  { createdBy }: { createdBy?: TopicAuthor },
): TopicAuthor =>
  createdBy && createdBy.name.trim() ? createdBy : { kind: "person", name: "" }
);

// ===== The pattern =====

export default pattern<TopicInput, TopicOutput>(
  (
    {
      title,
      body,
      comments,
      links,
      createdAt,
      createdBy,
      bodyUpdatedBy,
      bodyUpdatedAt,
      titleUpdatedBy,
      titleUpdatedAt,
      mentionable,
      references,
      mentioned,
      boardCrossrefs,
      [SELF]: self,
    },
  ) => {
    // Session-local UI state (new-tab test: none of this should carry over).
    const commentDraft = new Writable.perSession("");
    const editingBody = new Writable.perSession(false);
    const bodyDraft = new Writable.perSession("");
    const editingTitle = new Writable.perSession(false);
    const titleDraft = new Writable.perSession("");
    const linkUrlDraft = new Writable.perSession("");
    const linkLabelDraft = new Writable.perSession("");
    const linkKindDraft = new Writable.perSession<TopicLinkKind>("web");
    const referencesDraft = new Writable.perSession<TopicMentionRefMap>({});

    // Browser mutations snapshot the current viewer's canonical Profile.
    // Agent-facing streams below deliberately remain wish-free and accept the
    // agent's content-level signature in the same event as the mutation.
    // One wish, not three: `#profile` resolves the profile itself, and `name`
    // and `avatar` are fields on it.
    const profileWish = wish<{ name: string; avatar: string }>({
      query: "#profile",
    });
    // A wish resolves after setup, so each of these stays a derivation. Reading
    // the fields once here would pin the page to the empty profile the topic
    // opened with: the composer's controls never enable, and a comment or edit
    // made through them carries blank attribution.
    const profileName = profileWish.result?.name ?? "";
    const profileAvatar = profileWish.result?.avatar ?? "";
    const hasProfile = profileName.trim().length > 0;
    const createdByView = createdByOf({ createdBy });

    // --- Streams (external API; also usable headlessly via CLI) ---

    const addComment = action<AddCommentEvent, AddCommentResult>(
      ({ body: text, agentName }) => {
        const trimmed = (text ?? "").trim();
        const author = topicAuthorFromAgent(agentName) ??
          rejectMutation("addComment", "agentName must be non-blank");
        if (!trimmed) rejectMutation("addComment", "body must be non-empty");
        return { comment: appendComment(comments, trimmed, author) };
      },
    );

    const addLink = action<AddLinkEvent, AddLinkResult>(
      ({ kind, url, label, agentName }) => {
        const trimmedUrl = (url ?? "").trim();
        const author = topicAuthorFromAgent(agentName) ??
          rejectMutation("addLink", "agentName must be non-blank");
        if (!trimmedUrl) rejectMutation("addLink", "url must be non-empty");
        if (!isSafeLinkUrl(trimmedUrl)) {
          rejectMutation("addLink", "url must be http(s)");
        }
        return { link: appendLink(links, trimmedUrl, kind, label, author) };
      },
    );

    const setBody = action<SetBodyEvent, SetBodyResult>(
      ({ body: text, agentName }) => {
        const author = topicAuthorFromAgent(agentName) ??
          rejectMutation("setBody", "agentName must be non-blank");
        const persisted = text ?? "";
        body.set(persisted);
        // Every edit stamps. The unsigned path used to write the body and
        // leave these alone, which left the PREVIOUS author's name sitting on
        // content they did not write — a misattribution the verb reported as
        // success.
        const bodyUpdatedAtValue = Date.now();
        bodyUpdatedBy.set(author);
        bodyUpdatedAt.set(bodyUpdatedAtValue);
        return {
          body: persisted,
          bodyUpdatedBy: author,
          bodyUpdatedAt: bodyUpdatedAtValue,
        };
      },
    );

    const setTitle = action<SetTitleEvent, SetTitleResult>(
      ({ title: text, agentName }) => {
        const trimmed = (text ?? "").trim();
        // No legacy fallback and no omission tolerance: this verb postdates
        // the unsigned-caller era, so attribution is simply required.
        const author = topicAuthorFromAgent(agentName ?? "") ??
          rejectMutation("setTitle", "agentName must be non-blank");
        if (!trimmed) rejectMutation("setTitle", "title must be non-empty");
        return persistTitle(
          title,
          titleUpdatedBy,
          titleUpdatedAt,
          trimmed,
          author,
        );
      },
    );

    /**
     * Record a reference to another piece.
     *
     * Writes the destination ITSELF into the map — no address is parsed, no id
     * is minted for the target, and nothing is written into the target. What
     * makes this an edge is that the stored value and the piece are the same
     * cell.
     *
     * The entry carries a key but no prose token, so a mention made this way is
     * a reference without a sentence around it. The editor leaves it alone: it
     * only collects keys it saw when the document loaded or minted itself, so a
     * key that arrived from elsewhere is kept.
     */
    const mention = action<MentionEvent>(({ topic }) => {
      // A reference, or a rejection. The schema wraps whatever it is handed as
      // a cell without looking behind it, so this is the boundary — and the
      // narrowed payload is what makes it one read of one field: `undefined`
      // is a value with no document behind it, and any real piece answers with
      // an object because `title` carries a default.
      if (!topic || topic.get() === undefined) {
        rejectMutation("mention", "topic must be a reference");
      }
      // A set-add, not an append: referencing the same piece twice is one
      // reference. Mergeable, so concurrent mentions of distinct pieces all
      // land and a repeated one is a no-op against durable state.
      mentioned.addUnique(topic);
    });

    /** Stop referencing a piece — every entry naming it. */
    const unmention = action<UnmentionEvent>(({ topic }) => {
      // Same check as `mention`, and it earns its place here too: a payload
      // that is not a reference matches no stored entry, so the removal below
      // would quietly do nothing and report success.
      if (!topic || topic.get() === undefined) {
        rejectMutation("unmention", "topic must be a reference");
      }
      // `removeByValue`, not `remove` or `removeAll`: those two rebuild the
      // array and set it back, which is both a clobbering write and the shape
      // that flattens surviving references. This one resolves against durable
      // state, so concurrent removals of distinct entries merge.
      mentioned.removeByValue(topic);
    });

    // --- UI-side actions (close over session drafts) ---

    const submitComment = submitProfileComment({
      comments,
      commentDraft,
      profileName,
      profileAvatar,
    });

    const startEditTitle = action(() => {
      titleDraft.set(title.get());
      editingTitle.set(true);
    });

    const saveTitle = saveProfileTitle({
      title,
      titleDraft,
      editingTitle,
      titleUpdatedBy,
      titleUpdatedAt,
      profileName,
      profileAvatar,
    });

    // Nothing to undo: the draft is session-local, so leaving it behind IS
    // the discard.
    const cancelEditTitle = action(() => {
      editingTitle.set(false);
    });

    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      // Seeded together with the prose, so the editor opens on a map that
      // resolves every token the draft carries. Each `destination` crosses as
      // a link, which is what `unknown` is declared for.
      referencesDraft.set(references.get());
      editingBody.set(true);
    });

    const saveBody = saveProfileBody({
      body,
      bodyDraft,
      references,
      referencesDraft,
      editingBody,
      bodyUpdatedBy,
      bodyUpdatedAt,
      profileName,
      profileAvatar,
    });

    // Nothing to undo: the prose and its mention map are both session drafts,
    // so leaving them behind IS the discard.
    const cancelEditBody = action(() => {
      editingBody.set(false);
    });

    const submitLink = submitProfileLink({
      links,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      profileName,
      profileAvatar,
    });

    // --- Derived values ---

    // Each of these reads its own topic's data, which the page renders in full
    // anyway, and the shrunk schemas say so: a `.length` read declares
    // `items: unknown` and never expands an element.
    const commentCount = comments.get().length;

    const lastActivityAt = lastActivityOf({
      comments,
      links,
      createdAt,
      bodyUpdatedAt,
      titleUpdatedAt,
    });

    const commentsView = comments.get().toSorted((a, b) => a.sentAt - b.sentAt);

    const linksView = links.get();
    const hasLinks = linksView.length > 0;
    const hasComments = commentCount > 0;
    const hasBody = body.get().trim().length > 0;

    // Inbound: who points at this topic, looked up in the board's pivot rather
    // than derived a second time.
    const referencedBy = backlinksOf({
      table: boardCrossrefs,
      self,
    });
    const hasReferences = referencedBy.length > 0;
    // Only what THIS pattern owns is offered for removal. The union `mentions`
    // also carries the editor's map and the link resolutions, and a control
    // here could not honestly retract either: a mention in the prose is removed
    // by editing the prose, and a link's reference belongs to the link.
    const mentionedView = mentioned.get();
    const hasMentioned = mentionedView.length > 0;

    const topicName = title.get().trim() || "(untitled topic)";

    // Declared BEFORE the link resolution below, and the ordering is
    // load-bearing rather than stylistic. A `.map()` over a reactive array
    // lowers to an inline pattern, and inline patterns are NUMBERED IN SOURCE
    // ORDER. A deployed piece records the number it was instantiated from, so
    // inserting a new map ahead of an existing one renumbers that one and
    // strands every piece already made by it — `deno task pattern-vintage`
    // reports it as a refused update, which is how this was found. New maps
    // therefore go after the ones already here, and the rendered view holds
    // two of them.
    const view = (
      <cf-theme theme={TOPICS_THEME}>
        <cf-screen>
          <cf-vstack slot="header" gap="1" padding="4">
            {editingTitle
              ? (
                <cf-hstack gap="2" align="center">
                  <cf-input
                    $value={titleDraft}
                    placeholder="Topic title…"
                    style="font-size: 1.25rem; font-weight: 600; flex: 1;"
                  />
                  <cf-button
                    variant="primary"
                    disabled={!hasProfile}
                    onClick={saveTitle}
                  >
                    Save
                  </cf-button>
                  <cf-button variant="ghost" onClick={cancelEditTitle}>
                    Cancel
                  </cf-button>
                </cf-hstack>
              )
              : (
                <cf-hstack gap="2" justify="between" align="center">
                  <cf-text
                    block
                    style="font-size: 1.25rem; font-weight: 600;"
                  >
                    {topicName}
                  </cf-text>
                  <cf-button
                    variant="ghost"
                    disabled={!hasProfile}
                    onClick={startEditTitle}
                  >
                    Rename
                  </cf-button>
                </cf-hstack>
              )}
            <cf-hstack justify="between" align="center">
              <cf-text variant="caption" tone="muted">
                started by {topicAuthorLabel(createdByView)}
                {createdAt ? ` · ${whenLabel(createdAt)}` : ""}
              </cf-text>
              <cf-hstack gap="2" align="center">
                <cf-text variant="caption" tone="muted">Acting as</cf-text>
                {hasProfile
                  ? (
                    <cf-profile-badge
                      $profile={profileWish.result}
                      size="sm"
                      noNavigate
                    />
                  )
                  : <div>{profileWish[UI]}</div>}
              </cf-hstack>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="3" padding="4">
            {/* ── The living body document ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack justify="between" align="center">
                  <cf-heading level={5}>Body</cf-heading>
                  {editingBody ? null : (
                    <cf-button
                      variant="secondary"
                      disabled={!hasProfile}
                      onClick={startEditBody}
                    >
                      Edit
                    </cf-button>
                  )}
                </cf-hstack>

                {editingBody
                  ? (
                    <cf-vstack gap="2">
                      <cf-code-editor
                        $value={bodyDraft}
                        $mentionable={mentionable}
                        $references={referencesDraft}
                        language="text/markdown"
                        mode="prose"
                        wordWrap
                        tabIndent
                        placeholder="The topic's living document…"
                        style="min-height: 12rem;"
                      />
                      <cf-hstack gap="2">
                        <cf-button
                          variant="primary"
                          disabled={!hasProfile}
                          onClick={saveBody}
                        >
                          Save
                        </cf-button>
                        <cf-button variant="ghost" onClick={cancelEditBody}>
                          Cancel
                        </cf-button>
                      </cf-hstack>
                    </cf-vstack>
                  )
                  : hasBody
                  ? <cf-markdown content={body} />
                  : (
                    <cf-text tone="muted" block>
                      No body yet. The body is this topic's living document —
                      durable conclusions get folded up here while the thread
                      below holds the deliberation.
                    </cf-text>
                  )}
                {bodyUpdatedAt.get()
                  ? (
                    <cf-text variant="caption" tone="muted">
                      Last updated by {topicAuthorLabel(bodyUpdatedBy.get())}
                      {" · "}
                      {whenLabel(bodyUpdatedAt.get() ?? 0)}
                    </cf-text>
                  )
                  : null}
              </cf-vstack>
            </cf-card>

            {/* ── Links out ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Links</cf-heading>
                {hasLinks
                  ? (
                    <cf-vstack gap="1">
                      {linksView.map((link) => (
                        <cf-hstack gap="2" align="center">
                          <cf-badge size="xs" color="neutral">
                            {link.kind}
                          </cf-badge>
                          {isSafeLinkUrl(link.url)
                            ? (
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                style="color: inherit;"
                              >
                                {link.label || link.url}
                              </a>
                            )
                            : (
                              <cf-text tone="muted">
                                {link.label || link.url}
                              </cf-text>
                            )}
                          {link.addedBy
                            ? (
                              <cf-text variant="caption" tone="muted">
                                by {topicAuthorLabel(link.addedBy)}
                              </cf-text>
                            )
                            : null}
                        </cf-hstack>
                      ))}
                    </cf-vstack>
                  )
                  : (
                    <cf-text tone="muted" block>
                      No links yet — PRs, agent sessions, other topics.
                    </cf-text>
                  )}
                <cf-hstack gap="2" align="end">
                  <cf-field label="Kind" style="width: 130px;">
                    <cf-select
                      $value={linkKindDraft}
                      items={LINK_KIND_ITEMS}
                    />
                  </cf-field>
                  <cf-field label="URL" style="flex: 1;">
                    <cf-input $value={linkUrlDraft} placeholder="https://…" />
                  </cf-field>
                  <cf-field label="Label" style="width: 180px;">
                    <cf-input
                      $value={linkLabelDraft}
                      placeholder="optional"
                    />
                  </cf-field>
                  <cf-button
                    variant="secondary"
                    disabled={!hasProfile}
                    onClick={submitLink}
                  >
                    Add
                  </cf-button>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            {/* ── The thread ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack justify="between" align="center">
                  <cf-heading level={5}>Thread</cf-heading>
                  <cf-text variant="caption" tone="muted">
                    {commentCount} comments
                  </cf-text>
                </cf-hstack>

                {hasComments
                  ? (
                    <cf-vstack gap="2">
                      {commentsView.map((comment) => (
                        <cf-vstack
                          gap="0"
                          style="border-left: 2px solid var(--cf-theme-color-border); padding-left: 0.75rem;"
                        >
                          <cf-hstack gap="2" align="center">
                            <cf-avatar
                              src={comment.author?.avatar || ""}
                              name={topicAuthorLabel(comment.author)}
                              size="xs"
                            />
                            <cf-text style="font-weight: 600;">
                              {topicAuthorLabel(comment.author)}
                            </cf-text>
                            <cf-text variant="caption" tone="muted">
                              {whenLabel(comment.sentAt)}
                            </cf-text>
                          </cf-hstack>
                          <cf-text block style="white-space: pre-wrap;">
                            {comment.body}
                          </cf-text>
                        </cf-vstack>
                      ))}
                    </cf-vstack>
                  )
                  : (
                    <cf-text tone="muted" block>
                      No comments yet.
                    </cf-text>
                  )}

                <cf-hstack gap="2" align="end">
                  <cf-field label="Comment" style="flex: 1;">
                    <cf-textarea
                      $value={commentDraft}
                      rows={3}
                      placeholder="Add to the thread…"
                    />
                  </cf-field>
                  <cf-button
                    variant="primary"
                    disabled={!hasProfile}
                    onClick={submitComment}
                  >
                    Send
                  </cf-button>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            {/* ── Referenced by (the board's pivot; nothing persisted) ── */}
            {hasReferences
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>Referenced by</cf-heading>
                    <cf-vstack gap="1">
                      {referencedBy.map((topic) => (
                        <cf-cell-link $cell={topic} />
                      ))}
                    </cf-vstack>
                  </cf-vstack>
                </cf-card>
              )
              : null}

            {/* ── References made outside the prose (the `mention` verb) ── */}
            {hasMentioned
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>References</cf-heading>
                    <cf-text variant="caption" tone="muted">
                      Added directly rather than written into the body. A
                      mention inside the text is removed by editing the text.
                    </cf-text>
                    <cf-vstack gap="1">
                      {mentionedView.map((topic) => (
                        <cf-hstack gap="2" align="center">
                          <cf-cell-link $cell={topic} />
                          <cf-button
                            variant="ghost"
                            onClick={dropMention({ mentioned, topic })}
                          >
                            Remove
                          </cf-button>
                        </cf-hstack>
                      ))}
                    </cf-vstack>
                  </cf-vstack>
                </cf-card>
              )
              : null}
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    );

    // A link's URL, asked of `cellFromUrl` once per link. Most answer with no
    // cell — they are web pages — and those simply are not mentions.
    const linkUrls = links.get().map((link) => link.url ?? "");
    const linkTargets = linkUrls.map((url) => cellFromUrl({ url }));
    // Outbound: what this topic points at. Only this half depends on the
    // topic's own content, which is what keeps the board's join reading one
    // small list per topic.
    const mentions = mentionsOf({ references, mentioned, linkTargets });

    return {
      [NAME]: topicName,
      [UI]: view,
      title,
      body,
      comments,
      links,
      createdAt,
      createdBy: createdByView,
      bodyUpdatedBy,
      bodyUpdatedAt,
      commentCount,
      lastActivityAt,
      references,
      mentioned,
      mentions,
      referencedBy,
      titleUpdatedBy,
      titleUpdatedAt,
      addComment,
      addLink,
      setBody,
      setTitle,
      mention,
      unmention,
      commentDraft,
      bodyDraft,
      editingBody,
      titleDraft,
      editingTitle,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      referencesDraft,
      startEditTitle,
      saveTitle,
      cancelEditTitle,
      submitComment,
      startEditBody,
      saveBody,
      cancelEditBody,
      submitLink,
    };
  },
);
