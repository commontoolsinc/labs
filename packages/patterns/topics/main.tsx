import {
  action,
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import Topic, {
  asArray,
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
  /** The viewer's display name (normalized to "" until set). */
  myName: string;
  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle: Writable<string>;
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

  const sortedTopics = computed(() =>
    asArray(topics.get())
      .filter((t) => t)
      .toSorted((a, b) => (b?.lastActivityAt ?? 0) - (a?.lastActivityAt ?? 0))
  );

  const hasNoTopics = computed(() => sortedTopics.length === 0);

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
            {computed(() =>
              sortedTopics.map((topic) => (
                <cf-card>
                  <cf-hstack gap="3" align="center">
                    <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                      <cf-text block style="font-weight: 600;">
                        {topic.title || "(untitled topic)"}
                      </cf-text>
                      {topic.body
                        ? (
                          <cf-text tone="muted" block truncate>
                            {snippet(topic.body, 120)}
                          </cf-text>
                        )
                        : null}
                      <cf-text variant="caption" tone="muted">
                        {topic.commentCount} comments · by{" "}
                        {topic.createdByName || "someone"} ·{" "}
                        {whenLabel(topic.lastActivityAt)}
                      </cf-text>
                    </cf-vstack>
                    <cf-button
                      variant="secondary"
                      onClick={openTopic({ topic })}
                    >
                      Open
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              ))
            )}

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
    myName: myNameView,
    newTitle,
    addTopic,
    setMyName,
    submitTopic,
  };
});
