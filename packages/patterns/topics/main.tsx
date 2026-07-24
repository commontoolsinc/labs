import {
  action,
  computed,
  Default,
  entityRefToString,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import Topic, {
  asArray,
  crossrefChipRow,
  crossrefJoin,
  fidPayload,
  openTopic,
  snippet,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  topicCorpus,
  type TopicPiece,
  TOPICS_THEME,
  whenLabel,
} from "./topic.tsx";

// Re-export the shared types for consumers and tests.
export type {
  AddCommentEvent,
  AddLinkEvent,
  AgentAuthoredEvent,
  SetBodyEvent,
  TopicAuthor,
  TopicComment,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicOutput,
  TopicPiece,
} from "./topic.tsx";

export interface TopicsInput {
  topics?: Writable<TopicPiece[] | Default<[]>>;
  /** @deprecated Retained while pre-Profile callers still use the old
   * `setMyName` + unsigned-event contract. New callers use `agentName`. */
  myName?: PerUser<Writable<string | Default<"">>>;
}

export interface AddTopicEvent {
  title: string;
  /** The agent making this mutation. The authenticated principal remains the
   * human whose identity key invoked the stream; this is the agent's explicit
   * content-level signature under that shared principal. Optional only so
   * callers of the previous deployed schema remain valid; new callers must
   * provide a non-blank name. */
  agentName?: string;
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
  mentionable: TopicPiece[] | Default<[]>;
  topicCount: number;
  /** The prose reference graph over the board's own topics, one row per
   * (non-null) entry of `topics`. Rows carry their topic, so consumers never
   * need to correlate by index — indices are not a stable address. */
  crossrefs: TopicCrossref[] | Default<[]>;
  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle?: PerSession<Writable<string>>;
  addTopic: Stream<AddTopicEvent>;
  /** @deprecated Compatibility view for callers of the previous board. */
  myName: string;
  /** @deprecated Compatibility mutation for callers of the previous board. */
  setMyName: Stream<{ name: string }>;
  /** Submit the footer composer as the current viewer's canonical Profile. */
  submitTopic: Stream<void>;
}

// Navigation + chip-row live with the other shared pieces in topic.tsx (the
// detail page renders the same chips); re-exported here so embedders and
// tests keep importing them from the tracker.
export { crossrefChipRow, openTopic } from "./topic.tsx";

/** Browser composer submit. Profile wishes are resolved by the pattern and
 * bound into this handler as plain snapshot values, which keeps the mutation
 * independently testable without weakening the canonical Profile path. */
export const submitProfileTopic = handler<void, {
  topics: Writable<TopicPiece[] | Default<[]>>;
  mentionable: Writable<TopicPiece[] | Default<[]>>;
  newTitle: Writable<string>;
  myName: Writable<string | Default<"">>;
  profileName: string;
  profileAvatar: string;
}>((_, {
  topics,
  mentionable,
  newTitle,
  myName,
  profileName,
  profileAvatar,
}) => {
  const trimmed = (newTitle.get() ?? "").trim();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!trimmed || !author) return;
  const piece = Topic({
    title: trimmed,
    createdAt: Date.now(),
    createdBy: author,
    createdByName: topicAuthorLabel(author),
    myName,
    mentionable,
  });
  topics.push(piece);
  newTitle.set("");
});

export default pattern<TopicsInput, TopicsOutput>(({ topics, myName }) => {
  const newTitle = new Writable.perSession("");

  // Browser authorship comes from the current viewer's canonical Profile.
  // CLI streams below remain wish-free: agents sign each mutation in the
  // event payload, while Fabric records the human principal behind the key.
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

  const addTopic = action(({ title, agentName }: AddTopicEvent) => {
    const trimmed = (title ?? "").trim();
    const author = topicAuthorFromAgent(agentName ?? "");
    if (!trimmed || (agentName !== undefined && !author)) return;
    const legacyName = author
      ? topicAuthorLabel(author)
      : (myName.get() ?? "").trim() || "someone";
    const piece = Topic({
      title: trimmed,
      createdAt: Date.now(),
      createdBy: author,
      createdByName: legacyName,
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

  const submitTopic = submitProfileTopic({
    topics,
    mentionable: topics,
    newTitle,
    myName,
    profileName,
    profileAvatar,
  });

  const myNameView = computed(() => myName.get() ?? "");

  const topicCount = computed(() => asArray(topics.get()).length);

  // The prose reference graph as one piece-valued view over the board's own
  // topics (one row per non-null entry), recomputed from the whole corpus on
  // any board change (O(topics × text) — trivial at board scale; the growth
  // path is per-topic memoization). Identity is each entry's resolved
  // result-doc fid, so the existing corpus lights up with zero authoring
  // changes and nothing derived is persisted. Rows carry their pieces
  // directly: the UI binds navigation handlers to the row pieces (safe since
  // #4714's path-scoped wildcard fix — before it, a handler bound to a piece
  // nested inside a derived wrapper object silently kept the consuming UI
  // computed from ever running, which forced the earlier index-plumbed shape).
  const crossrefs = computed(() => {
    const list = asArray(topics.get());
    // Each entry's own fid payload ("" while unresolved, e.g. mid-sync — such
    // entries simply hold no edges this render). resolveAsCell/entityId are
    // cell-runtime surface, not on the pattern Writable type (same cast as
    // notes' appendLink).
    const payloads = list.map((t, i) => {
      if (!t) return "";
      const ref = (topics.key(i) as any).resolveAsCell?.()?.entityId;
      return ref ? fidPayload(entityRefToString(ref)) : "";
    });
    const { refsOut, referencedBy } = crossrefJoin(
      list.map((t) => topicCorpus(t)),
      payloads,
    );
    const rows: TopicCrossref[] = [];
    list.forEach((t, i) => {
      if (!t) return;
      rows.push({
        fid: payloads[i] ? `fid1:${payloads[i]}` : "",
        topic: t,
        refsOut: refsOut[i].map((j) => list[j]),
        referencedBy: referencedBy[i].map((j) => list[j]),
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

          <cf-vstack gap="2" padding="4">
            {computed(() => {
              // Iterate the piece-valued crossref rows directly (one per
              // non-null topic); each row carries its topic and the sibling
              // pieces it links, so the card binds navigation to row pieces
              // with no index indirection.
              const rows = crossrefs;
              const order = rows
                .map((_, i) => i)
                .filter((i) => rows[i]?.topic)
                .toSorted((a, b) =>
                  (rows[b]?.topic?.lastActivityAt ?? 0) -
                  (rows[a]?.topic?.lastActivityAt ?? 0)
                );
              return order.map((i) => {
                const row = rows[i];
                const t = row.topic;
                return (
                  <cf-card>
                    <cf-hstack gap="3" align="center">
                      <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                        <cf-text block style="font-weight: 600;">
                          {t.title || "(untitled topic)"}
                        </cf-text>
                        {t.body
                          ? (
                            <cf-text tone="muted" block truncate>
                              {snippet(t.body, 120)}
                            </cf-text>
                          )
                          : null}
                        <cf-text variant="caption" tone="muted">
                          {t.commentCount} comments · by{" "}
                          {topicAuthorLabel(t.createdBy, t.createdByName)} ·
                          {" "}
                          {whenLabel(t.lastActivityAt)}
                        </cf-text>
                        {crossrefChipRow("references →", false, row.refsOut)}
                        {crossrefChipRow(
                          "← referenced by",
                          true,
                          row.referencedBy,
                        )}
                      </cf-vstack>
                      <cf-button
                        variant="secondary"
                        onClick={openTopic({ topic: t })}
                      >
                        Open
                      </cf-button>
                    </cf-hstack>
                  </cf-card>
                );
              });
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
              <cf-button
                variant="primary"
                disabled={computed(() => !hasProfile)}
                onClick={submitTopic}
              >
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
    newTitle,
    addTopic,
    myName: myNameView,
    setMyName,
    submitTopic,
  };
});
