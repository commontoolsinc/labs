import {
  action,
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
  /** The board's own topics list — the sibling set for this topic's derived
   * crossrefs and the mention universe for authoring. A reference to the
   * tracker's array, wired at creation like `myName` (and backfillable as a
   * one-time link-bind on pieces created before it existed). Absent, the
   * detail page simply derives no connections.
   *
   * Declared at the deployed reference type: this is the pattern's accepted
   * argument, not a read. What bounds the read is the parameter type of the
   * derivation that consumes it (`topicCrossrefView` below takes `TopicScan`),
   * which is where a narrow declaration actually costs a consumer nothing. */
  mentionable?: Writable<TopicReference[] | Default<[]>>;
}

/**
 * The least a crossref join needs from a sibling: the prose it scans for pasted
 * fids, and the title it snapshots onto a rendered chip.
 *
 * This is the input type for any derivation over `mentionable`. That input is a
 * link to the whole board, so every field declared here is paid once per topic
 * on it — which is why this carries neither the summary scalars a board row
 * shows nor the display fields a rendered reference needs.
 */
export interface TopicMention {
  title: string;
  body: string;
  comments: { body: string }[];
  links: { url: string }[];
}

/**
 * `TopicMention` plus the scalars a board row summarises. The board's own
 * crossref derivation reads these; a single topic's does not.
 *
 * Both are input projections, not published types: every reference this pattern
 * publishes is declared at `TopicReference` or `TopicPiece`. Keeping them out of
 * the published surface is what leaves them free to shrink.
 */
export interface TopicScan extends TopicMention {
  createdAt: number;
  createdBy?:
    | TopicAuthor
    | Default<{ kind: "person"; name: "" }>
    | undefined;
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
}

/**
 * A sibling Topic as seen from another Topic: `TopicScan` plus the display
 * name and the mutation verbs, so a crossref chip can be rendered and acted on.
 */
export interface TopicReference extends TopicScan {
  /** The topic's display name. Like the other derived display fields, a cold
   * retained sibling may not have produced this path yet; its persisted title
   * remains authoritative until it does. */
  [NAME]: string | Default<""> | undefined;
  /** @deprecated Compatibility shadow for consumers of the previous result
   * schema. New callers must use `createdBy`; the pattern mirrors this field. */
  createdByName: string;
  comments: TopicComment[];
  links: TopicLink[];
  bodyUpdatedBy?: TopicAuthor | undefined;
  bodyUpdatedAt?: number | undefined;
  addComment: Stream<AddCommentEvent, AddCommentResult>;
  addLink: Stream<AddLinkEvent, AddLinkResult>;
  setBody: Stream<SetBodyEvent, SetBodyResult>;
}

/**
 * A #topic — a durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, and typed links out to other
 * core objects (PRs, agent sessions, other topics). Deliberately has no
 * status, labels, or assignees; what a topic grows next is part of the
 * experiment (CT-1878).
 *
 * This is the board-facing projection, and the one stored in the tracker's
 * list. Session-local UI controls are intentionally excluded: a TopicPiece can
 * be followed from a shared list even when the viewer has no matching
 * session-local cells. Crossref targets use the narrower `TopicScan` contract,
 * which is what stops a list read of topics from expanding, per topic, every
 * sibling that topic references.
 */
export interface TopicPiece extends TopicReference {
  /** This topic's own place in the board's prose graph, derived read-side
   * from `mentionable` (the sibling pieces it links, resolved from the
   * board's own list). Both sets stay empty until `mentionable` is wired.
   * Optional (2026-07-21 deploy): pieces healed before their `mentionable`
   * link exists carry a session-scoped crossrefs indirection that resolves
   * undefined outside the minting session; the list projection must accept
   * that rather than fail argument validation. */
  crossrefs?:
    | TopicEdges
    | Default<{ refsOut: []; referencedBy: [] }>
    | undefined;
}

/** One topic's row in the prose reference graph, as a sibling sees it. */
export interface TopicEdges {
  /** Sibling topics whose fids this topic's prose mentions. */
  refsOut: TopicReference[];
  /** Sibling topics whose prose mentions this topic's fid. */
  referencedBy: TopicReference[];
}

/** The same row on the topic's own page, which additionally carries the two
 * edge sets as durable fid/title snapshots so rendered navigation survives a
 * cold load without resolving a sibling. The snapshots stay off `TopicEdges`
 * because a sibling never renders them, and widening the projection every
 * reader of a topics list resolves is what a narrow declared schema exists to
 * prevent. */
export interface TopicCrossrefs extends TopicEdges {
  refsOutLinks?: TopicNavigationLink[];
  referencedByLinks?: TopicNavigationLink[];
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

/** The durable, non-reactive information a rendered link needs. Keeping this
 * separate from TopicReference avoids persisting a scheduler-backed click
 * stream in VDOM: the shell resolves the fid and owns navigation. */
export interface TopicNavigationLink {
  fid: string;
  title: string;
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

/** Every fid payload referenced anywhere in `text`, in match order,
 * duplicates included (callers dedupe as needed).
 *
 * Matches a fid in every shape people paste: bare `fid1:X`, storage-form
 * `of:fid1:X`, page URLs `https://host/space/fid1:X`, and share links where
 * the colon is percent-encoded (`fid1%3AX`). The base64url payload alone is
 * the identity — hosts and prefixes around it vary, and base64url survives
 * percent-encoding untouched. The length floor keeps prose that merely
 * mentions "fid1" from matching (real payloads are 43 chars of hash). The
 * regex lives inside the function: a module-scope `/g` RegExp is stateful
 * and the closure verifier rejects it as captured data. */
export const extractFidPayloads = (text: string): string[] => {
  const fidInText = /fid1(?::|%3a)([A-Za-z0-9_-]{20,})/gi;
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(fidInText)) out.push(m[1]);
  return out;
};

/** The payload of a `fid1:…` tagged hash string; "" for anything else. */
export const fidPayload = (fid: string): string => {
  const m = /^fid1:([A-Za-z0-9_-]{20,})$/.exec((fid ?? "").trim());
  return m ? m[1] : "";
};

/** The prose surfaces of one topic that count as reference edges: the body,
 * every comment body, and every link URL (the design's scan ∪ TopicLink).
 * Structurally typed so pure tests can drive it with literals. */
export const topicCorpus = (
  t:
    | {
      body?: string;
      comments?: readonly { body?: string }[];
      links?: readonly { url?: string }[];
    }
    | undefined
    | null,
): string => {
  if (!t) return "";
  const parts = [t.body ?? ""];
  for (const c of t.comments ?? []) parts.push(c?.body ?? "");
  for (const l of t.links ?? []) parts.push(l?.url ?? "");
  return parts.join("\n");
};

/** Join each corpus against the set of entry payloads: one shared
 * payload→index map, one scan per text — the shape a second consumer (notes,
 * when backlinks-index's write path retires) imports rather than forks.
 * refsOut[i] lists, in first-mention order, the entries whose fids appear in
 * corpus i; referencedBy is the inverse view (ascending by referrer).
 * Self-references, repeat mentions, and payloads no entry owns all drop;
 * "" payloads (unresolved entries) own nothing. */
export const crossrefJoin = (
  corpora: string[],
  payloads: string[],
): { refsOut: number[][]; referencedBy: number[][] } => {
  const byPayload = new Map<string, number>();
  payloads.forEach((p, i) => {
    if (p) byPayload.set(p, i);
  });
  const refsOut: number[][] = corpora.map(() => []);
  const referencedBy: number[][] = corpora.map(() => []);
  corpora.forEach((text, i) => {
    const seen = new Set<number>();
    for (const p of extractFidPayloads(text)) {
      const j = byPayload.get(p);
      if (j === undefined || j === i || seen.has(j)) continue;
      seen.add(j);
      refsOut[i].push(j);
      referencedBy[j].push(i);
    }
  });
  return { refsOut, referencedBy };
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

/** One row of crossref links ("references →" / "← referenced by"). The view
 * carries only durable fid/title snapshots; the public crossref result keeps
 * its existing piece-valued contract. */
export const crossrefLinkRow = (
  caption: string,
  links: TopicNavigationLink[] | undefined,
) =>
  (links ?? []).length === 0
    ? null
    : (
      <cf-hstack gap="1" align="center" style="flex-wrap: wrap;">
        <cf-text variant="caption" tone="muted">{caption}</cf-text>
        {(links ?? []).map((link) =>
          topicCellLink(
            link.fid,
            snippet(link.title || "(untitled topic)", 40),
          )
        )}
      </cf-hstack>
    );

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
// Each of these is a `lift` rather than a pattern-body derivation for one
// reason: the declared parameter type is what bounds the read. Their bodies
// call helpers (`topicCorpus`, `crossrefJoin`) that schema analysis cannot see
// through, and an inferred input schema falls back to reading its input whole —
// for anything reached through `mentionable`, that is the entire board.

/** This topic's own place in the board's prose graph, derived read-side from
 * the mentionable siblings — the same join the board's cards use, reduced to
 * this piece's row. Nothing persisted; a topic without `mentionable` derives
 * empty sets.
 *
 * HACK: reads `TopicMention`, publishes `TopicReference`, via an `as` on each
 * sibling. A reference passed through a lift is a link and resolves to the
 * whole topic regardless of how little the lift declared, so the cast matches
 * what a consumer receives while the narrow parameter bounds what this reads.
 * See the same note on `crossrefRows` in main.tsx. */
/**
 * Which entry of `mentionable` is this topic.
 *
 * Its own lift, declared over `unknown` items, because `.equals` compares cell
 * identity and never touches content: locating yourself among the siblings
 * reads nothing from any of them. A linear scan is fine at board scale — it is
 * a walk over cell identities, not a read — and keyed collections will give
 * this a direct lookup later.
 *
 * Deliberately not fid-based. An entry's fid is a resolution detail on its way
 * out; `.equals` against the title cell is the durable identity, and it is what
 * survives that removal.
 */
const findSelfIndex = lift((
  { siblings, title }: {
    siblings: ReadonlyCell<unknown[] | Default<[]>>;
    title: ComparableCell<unknown>;
  },
): number => {
  const list = siblings.get();
  const length = Array.isArray(list) ? list.length : 0;
  for (let index = 0; index < length; index++) {
    if (equals(siblings.key(index).key("title"), title)) return index;
  }
  return -1;
});

const topicCrossrefView = lift((
  { mentionable, me }: {
    // Reads `TopicMention` — title and prose, nothing else. The row below
    // republishes each sibling as the deployed `TopicReference` (see the HACK
    // note), so narrowing here costs a consumer nothing.
    mentionable: Writable<TopicMention[] | Default<[]>>;
    /** This topic's position, from `findSelfIndex`; -1 when not on the list. */
    me: number;
  },
): TopicCrossrefs => {
  const sibs = mentionable.get();
  const empty: TopicCrossrefs = {
    refsOut: [],
    referencedBy: [],
    refsOutLinks: [],
    referencedByLinks: [],
  };
  if (sibs.length === 0) return empty;
  // Each sibling's own fid payload ("" while unresolved — such entries hold no
  // edges this render). Cell-runtime surface cast, as in notes' appendLink.
  const payloads = sibs.map((t, i) => {
    if (!t) return "";
    const ref = (mentionable.key(i) as any).resolveAsCell?.()?.entityId;
    return ref ? fidPayload(entityRefToString(ref)) : "";
  });
  const joined = crossrefJoin(sibs.map((t) => topicCorpus(t)), payloads);
  if (me < 0 || me >= sibs.length || !sibs[me]) return empty;
  return {
    refsOut: joined.refsOut[me].map((j) => sibs[j] as TopicReference),
    referencedBy: joined.referencedBy[me].map((j) => sibs[j] as TopicReference),
    refsOutLinks: joined.refsOut[me].map((j) => ({
      fid: payloads[j] ? `fid1:${payloads[j]}` : "",
      title: sibs[j].title,
    })),
    referencedByLinks: joined.referencedBy[me].map((j) => ({
      fid: payloads[j] ? `fid1:${payloads[j]}` : "",
      title: sibs[j].title,
    })),
  };
});

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

    const crossrefs = topicCrossrefView({
      mentionable,
      me: findSelfIndex({ siblings: mentionable, title }),
    });

    const linksView = computed(() => links.get());
    const hasLinks = linksView.length > 0;
    const hasComments = commentCount > 0;
    const hasBody = body.get().trim().length > 0;
    // The snapshots are optional on the published sibling projection (a
    // sibling's row never renders them, and adding required fields there would
    // change the deployed `crossrefs` default). This topic's own row always
    // carries them — the derivation above sets both on every path.
    const hasConnections = (crossrefs.refsOutLinks ?? []).length +
        (crossrefs.referencedByLinks ?? []).length > 0;

    const topicName = title.get().trim() || "(untitled topic)";

    return {
      [NAME]: topicName,
      [UI]: (
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

              {/* ── Connections (derived crossrefs; nothing persisted) ── */}
              {hasConnections
                ? (
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={5}>Connections</cf-heading>
                      {crossrefLinkRow(
                        "references →",
                        crossrefs.refsOutLinks,
                      )}
                      {crossrefLinkRow(
                        "← referenced by",
                        crossrefs.referencedByLinks,
                      )}
                    </cf-vstack>
                  </cf-card>
                )
                : null}

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
            </cf-vstack>
          </cf-screen>
        </cf-theme>
      ),
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
      crossrefs,
      addComment,
      addLink,
      setBody,
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
