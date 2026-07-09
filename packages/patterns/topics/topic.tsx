import {
  action,
  computed,
  Default,
  NAME,
  pattern,
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
export interface TopicOutput {
  [NAME]: string;
  [UI]: VNode;
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

/** The shape stored in the tracker's list. */
export type TopicPiece = TopicOutput;

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
        authorName: myName.get().trim() || "someone",
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
        if (!trimmedUrl) return;
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
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                style="color: inherit;"
                              >
                                {link.label || link.url}
                              </a>
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
    };
  },
);
