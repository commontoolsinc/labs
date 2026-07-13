import {
  action,
  computed,
  Default,
  entityRefToString,
  handler,
  NAME,
  navigateTo,
  pattern,
  type PerSession,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import Topic, {
  asArray,
  extractFidPayloads,
  fidPayload,
  snippet,
  type TopicPiece,
  TOPICS_THEME,
  whenLabel,
} from "./topic.tsx";

// Re-export the shared types for consumers and tests.
export type {
  TopicComment,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicOutput,
  TopicPiece,
} from "./topic.tsx";

export interface TopicsInput {
  topics?: Writable<TopicPiece[] | Default<[]>>;
  /** The viewer's display name, set once per user and shared with every topic
   * this tracker creates ("commenting as"). */
  myName?: PerUser<Writable<string | Default<"">>>;
}

/** One topic's place in the prose reference graph. Derived at read time from
 * fids pasted in bodies, comments, and link URLs — never persisted, so a
 * partial-view replica can never destroy real edges (the failure class of
 * index patterns that write backlinks into their targets). */
export interface TopicCrossref {
  /** The topic's own fid in tagged form (`fid1:…`); "" until known. */
  fid: string;
  topic: TopicPiece;
  /** Sibling topics whose fids this topic's prose mentions. */
  refsOut: TopicPiece[];
  /** Sibling topics whose prose mentions this topic's fid. */
  referencedBy: TopicPiece[];
}

/**
 * Topics — a tracker over #topic pieces: durable units of shared attention
 * (CT-1878). Deliberately minimal: no statuses, labels, or assignees; topics
 * sort by last activity. Replaces Linear / GitHub issues / loose process docs
 * for the team; PR workflows stay in GitHub and arrive here as links.
 */
export interface TopicsOutput {
  [NAME]: string;
  [UI]: VNode;
  topics: TopicPiece[];
  mentionable: TopicPiece[];
  topicCount: number;
  /** The prose reference graph over the board's own topics, one row per
   * (non-null) entry of `topics`. Rows carry their topic, so consumers never
   * need to correlate by index — indices are not a stable address. */
  crossrefs: TopicCrossref[];
  /** The viewer's display name (normalized to "" until set). */
  myName: string;
  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle?: PerSession<Writable<string>>;
  addTopic: Stream<{ title: string }>;
  setMyName: Stream<{ name: string }>;
  /** Submit the footer composer: reads newTitle, delegates to addTopic. */
  submitTopic: Stream<void>;
}

/** Row navigation, bound per topic card. Module-scope handler (not an inline
 * closure) so embedders and tests can bind and drive it directly. */
export const openTopic = handler<void, { topic: TopicPiece }>(
  (_, { topic }) => {
    navigateTo(topic);
  },
);

/** One row of crossref chips ("references →" / "← referenced by"): each chip
 * names a sibling topic and navigates to it. Chips bind against direct
 * elements of the board's `topics` list — a handler bound to a piece nested
 * inside a derived wrapper object silently keeps the consuming UI computed
 * from ever running. Module-scope and pure so the single-runtime suite can
 * also drive the exact markup directly (pinning the no-edges → null branch)
 * alongside the real card path it renders via continuous UI demand. */
export const crossrefChipRow = (
  caption: string,
  accent: boolean,
  list: TopicPiece[],
  indices: number[],
) =>
  indices.length === 0
    ? null
    : (
      <cf-hstack gap="1" align="center" style="flex-wrap: wrap;">
        <cf-text variant="caption" tone="muted">{caption}</cf-text>
        {indices.map((j) => (
          <cf-chip
            label={snippet(list[j]?.title || "(untitled topic)", 40)}
            size="xs"
            color={accent ? "accent" : "neutral"}
            interactive
            oncf-click={openTopic({ topic: list[j] })}
          />
        ))}
      </cf-hstack>
    );

export default pattern<TopicsInput, TopicsOutput>(({ topics, myName }) => {
  const newTitle = new Writable.perSession("");

  const addTopic = action(({ title }: { title: string }) => {
    const trimmed = (title ?? "").trim();
    if (!trimmed) return;
    const piece = Topic({
      title: trimmed,
      createdAt: safeDateNow(),
      createdByName: (myName.get() ?? "").trim() || "someone",
      myName,
    });
    // Mergeable append: concurrent creates from different users all land.
    topics.push(piece);
    newTitle.set("");
  });

  const setMyName = action(({ name }: { name: string }) => {
    myName.set((name ?? "").trim());
  });

  const submitTopic = action(() => {
    addTopic.send({ title: newTitle.get() });
  });

  // Normalized snapshot: a never-written PerUser cell reads as undefined in
  // other runtimes; assertions need a real, stable value.
  const myNameView = computed(() => myName.get() ?? "");

  const topicCount = computed(() => asArray(topics.get()).length);

  // The prose reference graph as index edges over `topics` (raw order),
  // recomputed from the whole corpus on any board change (O(topics × text) —
  // trivial at board scale; the growth path is per-topic memoization).
  // Identity is each entry's resolved result-doc fid, so the existing corpus
  // lights up with zero authoring changes and nothing derived is persisted.
  // Indices, not pieces: the UI must bind its navigation handlers to direct
  // `topics` elements — a handler bound to a piece nested inside a derived
  // wrapper object silently keeps the consuming UI computed from ever
  // running.
  const crossrefEdges = computed(() => {
    const list = asArray(topics.get());
    // Each entry's own fid payload ("" while unresolved, e.g. mid-sync —
    // such entries simply hold no edges this render).
    const payloads = list.map((t, i) => {
      if (!t) return "";
      // resolveAsCell/entityId are cell-runtime surface, not on the pattern
      // Writable type (same cast as notes' appendLink).
      const ref = (topics.key(i) as any).resolveAsCell?.()?.entityId;
      return ref ? fidPayload(entityRefToString(ref)) : "";
    });
    // Every fid payload each topic's prose mentions.
    const mentions = list.map((t) => {
      if (!t) return new Set<string>();
      const parts = [t.body ?? ""];
      for (const c of asArray(t.comments)) parts.push(c?.body ?? "");
      for (const l of asArray(t.links)) parts.push(l?.url ?? "");
      return new Set(extractFidPayloads(parts.join("\n")));
    });
    return list.map((t, i) => {
      const refsOut: number[] = [];
      const referencedBy: number[] = [];
      if (t) {
        for (let j = 0; j < list.length; j++) {
          if (j === i || !list[j]) continue;
          if (payloads[j] && mentions[i].has(payloads[j])) refsOut.push(j);
          if (payloads[i] && mentions[j].has(payloads[i])) referencedBy.push(j);
        }
      }
      return {
        fid: payloads[i] ? `fid1:${payloads[i]}` : "",
        refsOut,
        referencedBy,
      };
    });
  });

  // Piece-valued view of the graph for consumers (tests, embedders, headless
  // reads) — reading pieces through the wrapper rows is fine, only handler
  // binds are not.
  const crossrefs = computed(() => {
    const list = asArray(topics.get());
    const rows: TopicCrossref[] = [];
    crossrefEdges.forEach((e, i) => {
      const t = list[i];
      if (!t) return;
      rows.push({
        fid: e.fid,
        topic: t,
        refsOut: e.refsOut.map((j) => list[j]),
        referencedBy: e.referencedBy.map((j) => list[j]),
      });
    });
    return rows;
  });

  const hasNoTopics = computed(() =>
    asArray(topics.get()).filter((t) => t).length === 0
  );

  return {
    [NAME]: computed(() => `Topics (${asArray(topics.get()).length})`),
    [UI]: (
      <cf-theme theme={TOPICS_THEME}>
        <cf-screen>
          <cf-vstack slot="header" gap="2" padding="4">
            <cf-hstack justify="between" align="center">
              <cf-vstack gap="0">
                <cf-heading level={3}>Topics</cf-heading>
                <cf-text variant="caption" tone="muted">
                  {topicCount} topics · durable units of shared attention
                </cf-text>
              </cf-vstack>
              <cf-field label="Commenting as" style="width: 180px;">
                <cf-input $value={myName} placeholder="Your name" />
              </cf-field>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="2" padding="4">
            {computed(() => {
              const list = asArray(topics.get());
              const edges = crossrefEdges;
              const order = list
                .map((_, i) => i)
                .filter((i) => list[i])
                .toSorted((a, b) =>
                  (list[b]?.lastActivityAt ?? 0) -
                  (list[a]?.lastActivityAt ?? 0)
                );
              return order.map((i) => (
                <cf-card>
                  <cf-hstack gap="3" align="center">
                    <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                      <cf-text block style="font-weight: 600;">
                        {list[i].title || "(untitled topic)"}
                      </cf-text>
                      {list[i].body
                        ? (
                          <cf-text tone="muted" block truncate>
                            {snippet(list[i].body, 120)}
                          </cf-text>
                        )
                        : null}
                      <cf-text variant="caption" tone="muted">
                        {list[i].commentCount} comments · by{" "}
                        {list[i].createdByName || "someone"} ·{" "}
                        {whenLabel(list[i].lastActivityAt)}
                      </cf-text>
                      {crossrefChipRow(
                        "references →",
                        false,
                        list,
                        edges[i]?.refsOut ?? [],
                      )}
                      {crossrefChipRow(
                        "← referenced by",
                        true,
                        list,
                        edges[i]?.referencedBy ?? [],
                      )}
                    </cf-vstack>
                    <cf-button
                      variant="secondary"
                      onClick={openTopic({ topic: list[i] })}
                    >
                      Open
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              ));
            })}

            {hasNoTopics
              ? (
                <cf-empty-state message="No topics yet. Start the first one below." />
              )
              : null}
          </cf-vstack>

          <cf-vstack slot="footer" gap="2" padding="4">
            <cf-hstack gap="2" align="end">
              <cf-field label="New topic" style="flex: 1;">
                <cf-input
                  $value={newTitle}
                  placeholder="What deserves shared attention?"
                />
              </cf-field>
              <cf-button variant="primary" onClick={submitTopic}>
                Start
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    ),
    topics,
    mentionable: topics,
    topicCount,
    crossrefs,
    myName: myNameView,
    newTitle,
    addTopic,
    setMyName,
    submitTopic,
  };
});
