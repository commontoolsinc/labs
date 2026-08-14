import {
  action,
  cellFromUrl,
  type ComparableCell,
  computed,
  Default,
  entityRefToString,
  equals,
  handler,
  lift,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  type ReadonlyCell,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// ===== Shared types =====

export type TopicLinkKind = "pr" | "topic" | "session" | "web";

/** A display snapshot attached atomically to content. Fabric remains the
 * authority for which principal/key performed the write. `kind: "agent"`
 * disambiguates an agent acting with its human user's key. */
export interface TopicAuthor {
  kind: "person" | "agent";
  name: string;
  avatar?: string;
}

export interface AgentAuthoredEvent {
  /** Explicit content-level signature for an agent using its human user's
   * identity key. Optional only so callers of the previous deployed schema
   * remain valid; new callers must provide a non-blank name. */
  agentName?: string;
}

export interface AddCommentEvent extends AgentAuthoredEvent {
  body: string;
}

export interface AddLinkEvent extends AgentAuthoredEvent {
  kind: TopicLinkKind;
  url: string;
  label: string;
}

export interface SetBodyEvent extends AgentAuthoredEvent {
  body: string;
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
   * Declared with NO required properties, deliberately. This payload's schema
   * reaches every topic in `mentionable`, so naming a field here would demand
   * it of pieces deployed before this verb existed and refuse their update
   * (`deno task pattern-vintage` catches exactly that). Nothing reads through
   * this anyway: it is stored and compared. */
  topic: Writable<unknown>;
}

/** Stop referencing a piece. */
export interface UnmentionEvent {
  topic: Writable<unknown>;
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

export interface TopicComment {
  /** Snapshot taken at write time (profile enrichment comes later; never gate
   * authorship on a profile wish — CT-1879). Comments carry no minted id:
   * array elements have stable entity identity; future editing addresses
   * elements by reference (`equals()`), not by a synthetic key. */
  author?: TopicAuthor;
  /** @deprecated Compatibility shadow for consumers of the previous result
   * schema. New callers must use `author`; the pattern mirrors this field. */
  authorName: string | Default<"">;
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
  /** @deprecated Compatibility shadow for the previous result contract. */
  createdByName?: string | Default<"">;
  /** @deprecated Retained only for callers of the previous unsigned mutation
   * streams. New callers use Profile authorship or an atomic `agentName`. */
  myName?: PerUser<Writable<string | Default<"">>>;
  bodyUpdatedBy?: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  bodyUpdatedAt?: Writable<number | Default<0>>;
  /** The board's own topics list — the mention universe the body editor
   * autocompletes over. A reference to the tracker's array, wired at creation
   * like `myName` (and backfillable as a one-time link-bind on pieces created
   * before it existed). Absent, the editor simply offers no completions. */
  mentionable?: Writable<TopicPiece[] | Default<[]>>;
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
 * One row of the board's mention pivot: a topic, and the topics that mention
 * it.
 *
 * Both sides are declared `unknown`, which is the whole design rather than a
 * shortcut. A row holds cell REFERENCES — `unknown` is the declaration that
 * lets a cell be written into one without a cast, and the one that stops any
 * reader of the table expanding a topic it did not ask for. Each consumer
 * declares what it wants to see through them.
 */
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

export interface TopicCrossrefRow {
  /** The topic this row is about. `unknown` because it is written as a
   * reference and only ever compared — `equals` takes the raw link. Anything
   * wider retrieves the piece instead of pointing at it: declared `object`,
   * this field reads back as the whole expanded topic, `$UI` tree included. */
  topic: unknown;
  mentionedBy: unknown[];
}

/**
 * The least a board row needs from a topic: its title, and the scalars a
 * full-board survey summarises.
 *
 * An input projection, not a published type — every reference this pattern
 * publishes is declared at `TopicPiece`. Keeping it out of the published
 * surface is what leaves it free to shrink.
 */
export interface TopicSummary {
  title: string;
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
  /** @deprecated Compatibility shadow for consumers of the previous result
   * schema. New callers must use `createdBy`; the pattern mirrors this field. */
  createdByName: string;
  body: string;
  comments: TopicComment[];
  links: TopicLink[];
  /** Every piece this topic's prose and links point at, as references.
   *
   * The board's pivot is declared over this and nothing else, so what one topic
   * costs a full-board scan is exactly this list of identities. Declared
   * `unknown[]` for the same reason the pivot is: these are references, and
   * comparing them never reads what is behind them. Declared as cells, because
   * that is what a consumer has to read them as to compare them at all.
   *
   * The default stands alone: a declared default and `| undefined` collide,
   * and the default is what a topic deployed before this path existed
   * materializes against. */
  mentions: unknown[] | Default<[]>;
  /** Where this topic's `[Label][key]` mentions point. Durable content, like
   * `links`. Written by the body editor; this pattern only ever reads it. */
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
  addComment: Stream<AddCommentEvent, AddCommentResult>;
  addLink: Stream<AddLinkEvent, AddLinkResult>;
  setBody: Stream<SetBodyEvent, SetBodyResult>;
  /** Reference another piece from this topic, and stop referencing it. The
   * browser equivalent is picking a completion in the body editor, which writes
   * the same map.
   *
   * OPTIONAL, unlike the verbs beside them, and for the reason every added path
   * on this projection is: a topic deployed before these existed carries
   * neither, and a required property it cannot produce refuses its update
   * outright. The older verbs predate every deployed generation, so they can
   * stay required; these cannot. */
  mention?: Stream<MentionEvent>;
  unmention?: Stream<UnmentionEvent>;
}

/** The complete result available when a Topic is instantiated directly. */
export interface TopicOutput extends TopicPiece {
  [UI]: VNode;
  /**
   * Session-local composer/edit state. These controls belong to a direct Topic
   * instance, not the shared TopicPiece projection used by the tracker's list.
   */
  commentDraft: PerSession<Writable<string>>;
  bodyDraft: PerSession<Writable<string>>;
  editingBody: PerSession<boolean>;
  linkUrlDraft: PerSession<Writable<string>>;
  linkLabelDraft: PerSession<Writable<string>>;
  linkKindDraft: PerSession<Writable<TopicLinkKind>>;
  /** UI affordances as streams: composer submit, body edit lifecycle. */
  submitComment: Stream<void>;
  startEditBody: Stream<void>;
  saveBody: Stream<void>;
  cancelEditBody: Stream<void>;
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
  legacyName: string | undefined = "",
): string => {
  const name = (author?.name ?? "").trim() ||
    (legacyName ?? "").trim() ||
    "someone";
  return author?.kind === "agent" ? `${name} (agent)` : name;
};

/** Only http(s) URLs may become live anchors — a user-supplied `javascript:`
 * href on a shared surface is script execution in every viewer's session.
 * Enforced at write (addLink rejects) AND at render (non-http renders as
 * text), since stored data may predate the write guard. */
export const isSafeLinkUrl = (url: string): boolean =>
  /^https?:\/\//i.test((url ?? "").trim());

/** The payload of a `fid1:…` tagged hash string; "" for anything else. The
 * length floor is what distinguishes a real address (43 chars of base64url
 * hash) from a string that merely starts with the tag. */
export const fidPayload = (fid: string): string => {
  const m = /^fid1:([A-Za-z0-9_-]{20,})$/.exec((fid ?? "").trim());
  return m ? m[1] : "";
};

/** A Topic destination rendered as data, not as a pattern-owned handler.
 * `cf-cell-link` resolves the fid in the active space and delegates ordinary
 * and Cmd/Ctrl-click navigation to the shell. This remains usable after a
 * cold load because the persisted VDOM contains no ephemeral event stream. */
export const topicCellLink = (fid: string, label: string) =>
  fid
    ? (
      <cf-cell-link
        link={`/of:${fid}`}
        label={label}
        static
      />
    )
    : null;

const LINK_KIND_ITEMS = [
  { label: "Web", value: "web" },
  { label: "PR", value: "pr" },
  { label: "Topic", value: "topic" },
  { label: "Agent session", value: "session" },
];

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
  comments.push({
    author,
    authorName: topicAuthorLabel(author),
    body: text.trim(),
    sentAt: Date.now(),
  });
  commentDraft.set("");
});

/** Browser body save under the current Profile snapshot. */
export const saveProfileBody = handler<void, {
  body: Writable<string | Default<"">>;
  bodyDraft: Writable<string>;
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
  links.push({
    kind: linkKindDraft.get(),
    url: url.trim(),
    label: linkLabelDraft.get().trim() || url.trim(),
    addedBy: author,
    addedAt: Date.now(),
  });
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

/** Max of creation, the newest comment, the newest link, and the last body
 * save — declared over just those four timestamp surfaces. */
const lastActivityOf = lift((
  { comments, links, createdAt, bodyUpdatedAt }: {
    comments: { sentAt: number }[];
    links: { addedAt?: number }[];
    createdAt: number;
    bodyUpdatedAt: number;
  },
): number => {
  let newest = Math.max(createdAt, bodyUpdatedAt);
  for (const c of comments) newest = Math.max(newest, c.sentAt);
  // `addedAt` is optional on TopicLink: links written before it existed carry
  // no timestamp and simply do not move the clock.
  for (const l of links) newest = Math.max(newest, l.addedAt ?? 0);
  return newest;
});

/** A legacy Topic has only `createdByName`. Project that snapshot into the
 * structured result instead of returning a dangling link to an absent optional
 * input path; sibling Topic schemas can then validate the piece. */
const createdByOf = lift((
  { createdBy, createdByName }: {
    createdBy?: TopicAuthor;
    createdByName: string;
  },
): TopicAuthor => {
  if (createdBy && createdBy.name.trim()) return createdBy;
  return { kind: "person", name: createdByName.trim() };
});

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
      createdByName,
      myName,
      bodyUpdatedBy,
      bodyUpdatedAt,
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
    const linkUrlDraft = new Writable.perSession("");
    const linkLabelDraft = new Writable.perSession("");
    const linkKindDraft = new Writable.perSession<TopicLinkKind>("web");

    // Browser mutations snapshot the current viewer's canonical Profile.
    // Agent-facing streams below deliberately remain wish-free and accept the
    // agent's content-level signature in the same event as the mutation.
    // One wish, not three: `#profile` resolves the profile itself, and `name`
    // and `avatar` are fields on it.
    const profileWish = wish<{ name: string; avatar: string }>({
      query: "#profile",
    });
    const profileName = profileWish.result?.name ?? "";
    const profileAvatar = profileWish.result?.avatar ?? "";
    const hasProfile = profileName.trim().length > 0;
    const createdByView = createdByOf({ createdBy, createdByName });

    // --- Streams (external API; also usable headlessly via CLI) ---

    const addComment = action<AddCommentEvent, AddCommentResult>(
      ({ body: text, agentName }) => {
        const trimmed = (text ?? "").trim();
        const author = topicAuthorFromAgent(agentName ?? "");
        if (agentName !== undefined && !author) {
          rejectMutation(
            "addComment",
            "agentName must be non-blank when given",
          );
        }
        if (!trimmed) rejectMutation("addComment", "body must be non-empty");
        const legacyName = author
          ? topicAuthorLabel(author)
          : (myName.get() ?? "").trim() || "someone";
        const comment = {
          author,
          authorName: legacyName,
          body: trimmed,
          sentAt: Date.now(),
        };
        // Mergeable append: concurrent comments from different users all land.
        comments.push(comment);
        return { comment };
      },
    );

    const addLink = action<AddLinkEvent, AddLinkResult>(
      ({ kind, url, label, agentName }) => {
        const trimmedUrl = (url ?? "").trim();
        const author = topicAuthorFromAgent(agentName ?? "");
        if (agentName !== undefined && !author) {
          rejectMutation("addLink", "agentName must be non-blank when given");
        }
        if (!trimmedUrl) rejectMutation("addLink", "url must be non-empty");
        if (!isSafeLinkUrl(trimmedUrl)) {
          rejectMutation("addLink", "url must be http(s)");
        }
        const link = {
          kind: kind ?? "web",
          url: trimmedUrl,
          label: (label ?? "").trim() || trimmedUrl,
          addedBy: author,
          addedAt: Date.now(),
        };
        links.push(link);
        return { link };
      },
    );

    const setBody = action<SetBodyEvent, SetBodyResult>(
      ({ body: text, agentName }) => {
        const author = topicAuthorFromAgent(agentName ?? "");
        if (agentName !== undefined && !author) {
          rejectMutation("setBody", "agentName must be non-blank when given");
        }
        const persisted = text ?? "";
        body.set(persisted);
        if (!author) return { body: persisted };
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
      if (!topic) rejectMutation("mention", "topic must be a reference");
      // A set-add, not an append: referencing the same piece twice is one
      // reference. Mergeable, so concurrent mentions of distinct pieces all
      // land and a repeated one is a no-op against durable state.
      mentioned.addUnique(topic);
    });

    /** Stop referencing a piece — every entry naming it. */
    const unmention = action<UnmentionEvent>(({ topic }) => {
      if (!topic) rejectMutation("unmention", "topic must be a reference");
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

    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      editingBody.set(true);
    });

    const saveBody = saveProfileBody({
      body,
      bodyDraft,
      editingBody,
      bodyUpdatedBy,
      bodyUpdatedAt,
      profileName,
      profileAvatar,
    });

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
    });

    // `computed()` here and for `linksView` below is not ceremony: a `.get()`
    // whose result is the array itself — bare, or fed to a callback-taking
    // method — is the shape the transformer rejects at pattern scope. Scalar
    // reductions like `comments.get().length` need no wrapper.
    const commentsView = computed(() =>
      comments.get().toSorted((a, b) => a.sentAt - b.sentAt)
    );

    const linksView = computed(() => links.get());
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
    const mentionedView = computed(() => mentioned.get());
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
            <cf-input
              $value={title}
              placeholder="Topic title…"
              style="font-size: 1.25rem; font-weight: 600;"
            />
            <cf-hstack justify="between" align="center">
              <cf-text variant="caption" tone="muted">
                started by {topicAuthorLabel(createdByView, createdByName)}
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
                        $references={references}
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
                              name={topicAuthorLabel(
                                comment.author,
                                comment.authorName,
                              )}
                              size="xs"
                            />
                            <cf-text style="font-weight: 600;">
                              {topicAuthorLabel(
                                comment.author,
                                comment.authorName,
                              )}
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
    const linkUrls = computed(() => links.get().map((link) => link.url ?? ""));
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
      createdByName,
      bodyUpdatedBy,
      bodyUpdatedAt,
      commentCount,
      lastActivityAt,
      references,
      mentioned,
      mentions,
      referencedBy,
      addComment,
      addLink,
      setBody,
      mention,
      unmention,
      commentDraft,
      bodyDraft,
      editingBody,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      submitComment,
      startEditBody,
      saveBody,
      cancelEditBody,
      submitLink,
    };
  },
);
