import {
  action,
  computed,
  Default,
  entityRefToString,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  type PerSession,
  type PerUser,
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
   * detail page simply derives no connections. */
  mentionable?: Writable<TopicReference[] | Default<[]>>;
}

/**
 * A #topic — a durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, and typed links out to other
 * core objects (PRs, agent sessions, other topics). Deliberately has no
 * status, labels, or assignees; what a topic grows next is part of the
 * experiment (CT-1878).
 */
/**
 * The shared-safe projection stored in the tracker's list. Session-local UI
 * controls are intentionally excluded: a TopicPiece can be followed from a
 * shared list even when the viewer has no matching session-local cells.
 */
export interface TopicReference {
  [NAME]: string;
  title: string;
  body: string;
  comments: TopicComment[];
  links: TopicLink[];
  createdAt: number;
  createdBy?: TopicAuthor;
  /** @deprecated Compatibility shadow for consumers of the previous result
   * schema. New callers must use `createdBy`; the pattern mirrors this field. */
  createdByName: string;
  bodyUpdatedBy?: TopicAuthor;
  bodyUpdatedAt?: number;
  commentCount: number;
  /** Max of creation, comments, body saves, and link additions. */
  lastActivityAt: number;
  addComment: Stream<AddCommentEvent>;
  addLink: Stream<AddLinkEvent>;
  setBody: Stream<SetBodyEvent>;
}

/**
 * The board-facing Topic projection. Crossref targets deliberately use the
 * non-recursive TopicReference contract: a Topic needs enough sibling data to
 * render and navigate chips, not each sibling's entire crossref graph.
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
    | { refsOut: TopicReference[]; referencedBy: TopicReference[] }
    | Default<{ refsOut: []; referencedBy: [] }>
    | undefined;
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

/** Safely coerce a reactive array read to an array (intermediate updates can
 * momentarily yield a non-array). Same guard as reading-list. */
export const asArray = <T,>(v: readonly T[] | T[]): T[] =>
  Array.isArray(v) ? v as T[] : [];

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
  for (const c of asArray(t.comments ?? [])) parts.push(c?.body ?? "");
  for (const l of asArray(t.links ?? [])) parts.push(l?.url ?? "");
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

/** Row navigation, bound per topic card and per crossref chip. Module-scope
 * handler (not an inline closure) so embedders and tests can bind and drive
 * it directly. */
export const openTopic = handler<void, { topic: TopicReference }>(
  (_, { topic }) => {
    navigateTo(topic);
  },
);

/** One row of crossref chips ("references →" / "← referenced by"): each chip
 * names a sibling topic and navigates to it. Takes the sibling pieces
 * directly and binds navigation to each — #4714's path-scoped wildcard fix
 * makes binding a piece reached through a derived crossref row safe (before
 * it, such a bind silently kept the consuming UI computed from ever running,
 * which forced the earlier index-plumbed shape). Module-scope and pure so the
 * single-runtime suite can also drive the exact markup directly (pinning the
 * no-edges → null branch) alongside the real card path it renders via
 * continuous UI demand. */
export const crossrefChipRow = (
  caption: string,
  accent: boolean,
  pieces: TopicReference[],
) =>
  pieces.length === 0
    ? null
    : (
      <cf-hstack gap="1" align="center" style="flex-wrap: wrap;">
        <cf-text variant="caption" tone="muted">{caption}</cf-text>
        {pieces.map((p) => (
          <cf-chip
            label={snippet(p?.title || "(untitled topic)", 40)}
            size="xs"
            color={accent ? "accent" : "neutral"}
            interactive
            oncf-click={openTopic({ topic: p })}
          />
        ))}
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
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const profileName = computed(() => profileNameWish.result ?? "");
    const profileAvatar = computed(() => profileAvatarWish.result ?? "");
    const hasProfile = computed(() =>
      profileName.trim().length > 0 && profileWish.result !== undefined
    );
    // A legacy Topic has only `createdByName`. Project that snapshot into the
    // structured result instead of returning a dangling link to an absent
    // optional input path; sibling Topic schemas can then validate the piece.
    const createdByView = computed(() => {
      const name = (createdBy?.name ?? "").trim();
      if (name) return createdBy;
      const legacyName = (createdByName ?? "").trim();
      return legacyName
        ? { kind: "person" as const, name: legacyName }
        : undefined;
    });

    // --- Streams (external API; also usable headlessly via CLI) ---

    const addComment = action(({ body: text, agentName }: AddCommentEvent) => {
      const trimmed = (text ?? "").trim();
      const author = topicAuthorFromAgent(agentName ?? "");
      if (!trimmed || (agentName !== undefined && !author)) return;
      const legacyName = author
        ? topicAuthorLabel(author)
        : (myName.get() ?? "").trim() || "someone";
      // Mergeable append: concurrent comments from different users all land.
      comments.push({
        author,
        authorName: legacyName,
        body: trimmed,
        sentAt: Date.now(),
      });
    });

    const addLink = action(
      ({ kind, url, label, agentName }: AddLinkEvent) => {
        const trimmedUrl = (url ?? "").trim();
        const author = topicAuthorFromAgent(agentName ?? "");
        if (
          !trimmedUrl || !isSafeLinkUrl(trimmedUrl) ||
          (agentName !== undefined && !author)
        ) return;
        links.push({
          kind: kind ?? "web",
          url: trimmedUrl,
          label: (label ?? "").trim() || trimmedUrl,
          addedBy: author,
          addedAt: Date.now(),
        });
      },
    );

    const setBody = action(({ body: text, agentName }: SetBodyEvent) => {
      const author = topicAuthorFromAgent(agentName ?? "");
      if (agentName !== undefined && !author) return;
      body.set(text ?? "");
      if (author) {
        bodyUpdatedBy.set(author);
        bodyUpdatedAt.set(Date.now());
      }
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

    const commentCount = computed(() => asArray(comments.get()).length);

    const lastActivityAt = computed(() => {
      const newestComment = asArray(comments.get())
        .reduce((max, c) => Math.max(max, c?.sentAt ?? 0), 0);
      const newestLink = asArray(links.get())
        .reduce((max, link) => Math.max(max, link?.addedAt ?? 0), 0);
      return Math.max(
        createdAt ?? 0,
        newestComment,
        newestLink,
        bodyUpdatedAt.get() ?? 0,
      );
    });

    const commentsView = computed(() =>
      asArray(comments.get())
        .filter((c) => c)
        .toSorted((a, b) => (a?.sentAt ?? 0) - (b?.sentAt ?? 0))
    );

    const linksView = computed(() => asArray(links.get()).filter((l) => l));

    // This topic's own place in the board's prose graph, derived read-side
    // from the mentionable siblings — the same join the board's cards use,
    // reduced to this piece's row (identified via SELF). Nothing persisted;
    // pre-rev pieces without `mentionable` simply derive empty sets.
    const crossrefs = computed(() => {
      const sibs = asArray(mentionable.get());
      if (sibs.length === 0) return { refsOut: [], referencedBy: [] };
      // Each sibling's own fid payload ("" while unresolved — such entries
      // hold no edges this render). Cell-runtime surface cast, as in notes'
      // appendLink.
      const payloads = sibs.map((t, i) => {
        if (!t) return "";
        const ref = (mentionable.key(i) as any).resolveAsCell?.()?.entityId;
        return ref ? fidPayload(entityRefToString(ref)) : "";
      });
      const joined = crossrefJoin(sibs.map((t) => topicCorpus(t)), payloads);
      // Self-identification via SELF + equals: needs #4714's path-scoped
      // wildcard fix — before it, the resolveAsCell chain above silently
      // erased self's comparable marking and this computed never ran.
      const me = sibs.findIndex((t) => t && equals(t, self));
      return me < 0 ? { refsOut: [], referencedBy: [] } : {
        refsOut: joined.refsOut[me].map((j) => sibs[j]),
        referencedBy: joined.referencedBy[me].map((j) => sibs[j]),
      };
    });

    const hasLinks = computed(() => linksView.length > 0);
    const hasComments = computed(() => commentsView.length > 0);
    const hasBody = computed(() => body.get().trim().length > 0);

    const topicName = computed(() => title.get().trim() || "(untitled topic)");

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
                        disabled={computed(() => !hasProfile)}
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
                            disabled={computed(() => !hasProfile)}
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
                        {computed(() =>
                          linksView.map((link) => (
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
                          ))
                        )}
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
                      disabled={computed(() => !hasProfile)}
                      onClick={submitLink}
                    >
                      Add
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </cf-card>

              {/* ── Connections (derived crossrefs; nothing persisted) ── */}
              {computed(() => {
                const { refsOut, referencedBy } = crossrefs;
                return refsOut.length === 0 && referencedBy.length === 0
                  ? null
                  : (
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={5}>Connections</cf-heading>
                        {crossrefChipRow("references →", false, refsOut)}
                        {crossrefChipRow("← referenced by", true, referencedBy)}
                      </cf-vstack>
                    </cf-card>
                  );
              })}

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
                        {computed(() =>
                          commentsView.map((comment) => (
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
                          ))
                        )}
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
                      disabled={computed(() => !hasProfile)}
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
