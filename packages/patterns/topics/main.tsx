import {
  action,
  computed,
  Default,
  entityRefToString,
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

import Topic, {
  asArray,
  crossrefChipRow,
  crossrefJoin,
  fidPayload,
  openTopic,
  snippet,
  topicCorpus,
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

// Navigation + chip-row live with the other shared pieces in topic.tsx (the
// detail page renders the same chips); re-exported here so embedders and
// tests keep importing them from the tracker.
export { crossrefChipRow, openTopic } from "./topic.tsx";

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
      // The board's own list, so the detail page can derive its connections
      // and the editor has a mention universe (backfilled as a one-time
      // link-bind on pieces created before this input existed).
      mentionable: topics,
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
    const { refsOut, referencedBy } = crossrefJoin(
      list.map((t) => topicCorpus(t)),
      payloads,
    );
    return list.map((_t, i) => ({
      fid: payloads[i] ? `fid1:${payloads[i]}` : "",
      refsOut: refsOut[i],
      referencedBy: referencedBy[i],
    }));
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
