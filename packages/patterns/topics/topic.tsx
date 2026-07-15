import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Shared types =====

export type TopicLinkKind = "pr" | "topic" | "session" | "web";

export interface TopicComment {
  /** Snapshot taken at write time (profile enrichment comes later; never gate
   * authorship on a profile wish — CT-1879). Comments carry no minted id:
   * array elements have stable entity identity; future editing addresses
   * elements by reference (`equals()`), not by a synthetic key. */
  authorName: string | Default<"">;
  body: string | Default<"">;
  sentAt: number | Default<0>;
}

export interface TopicLink {
  kind: TopicLinkKind | Default<"web">;
  url: string | Default<"">;
  label: string | Default<"">;
}

export interface TopicInput {
  title?: Writable<string | Default<"">>;
  /** The topic's living document: durable conclusions get folded up into the
   * body; the comment thread below holds the deliberation. */
  body?: Writable<string | Default<"">>;
  comments?: Writable<TopicComment[] | Default<[]>>;
  links?: Writable<TopicLink[] | Default<[]>>;
  createdAt?: number | Default<0>;
  createdByName?: string | Default<"">;
  /** The viewer's display name. Per-user: each authenticated identity gets its
   * own value on the same shared piece. The tracker passes its cell down so one
   * name covers the whole board. */
  myName?: PerUser<Writable<string | Default<"">>>;
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
export interface TopicPiece {
  [NAME]: string;
  title: string;
  body: string;
  comments: TopicComment[];
  links: TopicLink[];
  createdAt: number;
  createdByName: string;
  commentCount: number;
  /** Max of createdAt and the newest comment — the tracker sorts by this. */
  lastActivityAt: number;
  addComment: Stream<{ body: string }>;
  addLink: Stream<{ kind: TopicLinkKind; url: string; label: string }>;
  setBody: Stream<{ body: string }>;
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

const LINK_KIND_ITEMS = [
  { label: "Web", value: "web" },
  { label: "PR", value: "pr" },
  { label: "Topic", value: "topic" },
  { label: "Agent session", value: "session" },
];

// ===== The pattern =====

export default pattern<TopicInput, TopicOutput>(
  ({ title, body, comments, links, createdAt, createdByName, myName }) => {
    // Session-local UI state (new-tab test: none of this should carry over).
    const commentDraft = new Writable.perSession("");
    const editingBody = new Writable.perSession(false);
    const bodyDraft = new Writable.perSession("");
    const linkUrlDraft = new Writable.perSession("");
    const linkLabelDraft = new Writable.perSession("");
    const linkKindDraft = new Writable.perSession<TopicLinkKind>("web");

    // --- Streams (external API; also usable headlessly via CLI) ---

    const addComment = action(({ body: text }: { body: string }) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return;
      // Mergeable append: concurrent comments from different users all land.
      comments.push({
        // `?? ""`: a never-written PerUser cell can read as undefined (e.g. a
        // headless caller that never set a name) — same guard as myNameView.
        authorName: (myName.get() ?? "").trim() || "someone",
        body: trimmed,
        sentAt: safeDateNow(),
      });
    });

    const addLink = action(
      ({ kind, url, label }: {
        kind: TopicLinkKind;
        url: string;
        label: string;
      }) => {
        const trimmedUrl = (url ?? "").trim();
        if (!trimmedUrl || !isSafeLinkUrl(trimmedUrl)) return;
        links.push({
          kind: kind ?? "web",
          url: trimmedUrl,
          label: (label ?? "").trim() || trimmedUrl,
        });
      },
    );

    const setBody = action(({ body: text }: { body: string }) => {
      body.set(text ?? "");
    });

    // --- UI-side actions (close over session drafts) ---

    const submitComment = action(() => {
      const text = commentDraft.get();
      if (!text.trim()) return;
      addComment.send({ body: text });
      commentDraft.set("");
    });

    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      editingBody.set(true);
    });

    const saveBody = action(() => {
      // One whole-value set per explicit save keeps the conflict window small;
      // a live-bound textarea on a shared string would conflict per keystroke.
      body.set(bodyDraft.get());
      editingBody.set(false);
    });

    const cancelEditBody = action(() => {
      editingBody.set(false);
    });

    const submitLink = action(() => {
      const url = linkUrlDraft.get();
      if (!url.trim()) return;
      addLink.send({
        kind: linkKindDraft.get(),
        url,
        label: linkLabelDraft.get(),
      });
      linkUrlDraft.set("");
      linkLabelDraft.set("");
      linkKindDraft.set("web");
    });

    // --- Derived values ---

    const commentCount = computed(() => asArray(comments.get()).length);

    const lastActivityAt = computed(() => {
      const newest = asArray(comments.get())
        .reduce((max, c) => Math.max(max, c?.sentAt ?? 0), 0);
      return Math.max(createdAt ?? 0, newest);
    });

    const commentsView = computed(() =>
      asArray(comments.get())
        .filter((c) => c)
        .toSorted((a, b) => (a?.sentAt ?? 0) - (b?.sentAt ?? 0))
    );

    const linksView = computed(() => asArray(links.get()).filter((l) => l));

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
              <cf-text variant="caption" tone="muted">
                started by {createdByName || "someone"}
                {createdAt ? ` · ${whenLabel(createdAt)}` : ""}
              </cf-text>
            </cf-vstack>

            <cf-vstack gap="3" padding="4">
              {/* ── The living body document ── */}
              <cf-card>
                <cf-vstack gap="2">
                  <cf-hstack justify="between" align="center">
                    <cf-heading level={5}>Body</cf-heading>
                    {editingBody
                      ? null
                      : (
                        <cf-button variant="secondary" onClick={startEditBody}>
                          Edit
                        </cf-button>
                      )}
                  </cf-hstack>

                  {editingBody
                    ? (
                      <cf-vstack gap="2">
                        <cf-textarea
                          $value={bodyDraft}
                          rows={12}
                          placeholder="The topic's living document…"
                        />
                        <cf-hstack gap="2">
                          <cf-button variant="primary" onClick={saveBody}>
                            Save
                          </cf-button>
                          <cf-button variant="ghost" onClick={cancelEditBody}>
                            Cancel
                          </cf-button>
                        </cf-hstack>
                      </cf-vstack>
                    )
                    : hasBody
                    ? (
                      <cf-text block style="white-space: pre-wrap;">
                        {body}
                      </cf-text>
                    )
                    : (
                      <cf-text tone="muted" block>
                        No body yet. The body is this topic's living document —
                        durable conclusions get folded up here while the thread
                        below holds the deliberation.
                      </cf-text>
                    )}
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
                    <cf-button variant="secondary" onClick={submitLink}>
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
                        {computed(() =>
                          commentsView.map((comment) => (
                            <cf-vstack
                              gap="0"
                              style="border-left: 2px solid var(--cf-theme-color-border); padding-left: 0.75rem;"
                            >
                              <cf-hstack gap="2" align="center">
                                <cf-text style="font-weight: 600;">
                                  {comment.authorName || "someone"}
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
                    <cf-field label="Commenting as" style="width: 160px;">
                      <cf-input $value={myName} placeholder="Your name" />
                    </cf-field>
                    <cf-field label="Comment" style="flex: 1;">
                      <cf-textarea
                        $value={commentDraft}
                        rows={3}
                        placeholder="Add to the thread…"
                      />
                    </cf-field>
                    <cf-button variant="primary" onClick={submitComment}>
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
      createdByName,
      commentCount,
      lastActivityAt,
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
