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
  crossrefJoin,
  crossrefLinkRow,
  fidPayload,
  rejectMutation,
  snippet,
  type TopicAuthor,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  topicCellLink,
  topicCorpus,
  type TopicNavigationLink,
  type TopicPiece,
  TOPICS_THEME,
  whenLabel,
} from "./topic.tsx";

// Re-export the shared types for consumers and tests.
export type {
  AddCommentEvent,
  AddCommentResult,
  AddLinkEvent,
  AddLinkResult,
  AgentAuthoredEvent,
  SetBodyEvent,
  SetBodyResult,
  TopicAuthor,
  TopicComment,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicNavigationLink,
  TopicOutput,
  TopicPiece,
  TopicReference,
} from "./topic.tsx";

export interface TopicsInput {
  topics?: Writable<TopicPiece[] | Default<[]>>;
  /** @deprecated Retained while pre-Profile callers still use the old
   * `setMyName` + unsigned-event contract. New callers use `agentName`. */
  myName?: PerUser<Writable<string | Default<"">>>;
}

export interface AddTopicEvent {
  title: string;
  /** The topic's initial living-document body. A topic born with a body
   * appears with it atomically — no reader observes the title-only halfway
   * state, and no follow-up `setBody` call is needed to finish a create
   * (verb contract: the atomic-unit rule). */
  body?: string;
  /** The agent making this mutation. The authenticated principal remains the
   * human whose identity key invoked the stream; this is the agent's explicit
   * content-level signature under that shared principal. Optional only so
   * callers of the previous deployed schema remain valid; new callers must
   * provide a non-blank name. */
  agentName?: string;
}

export interface AddTopicResult {
  /** The topic this call created — the piece itself, not a manufactured
   * identifier. It reaches the caller as a link to the child, which the CLI
   * renders as an address (`cf piece call --show-links`); the pattern does
   * not mint fid fields of its own. A caller therefore addresses the new
   * topic straight from the create, instead of filing it and then searching
   * the board's crossrefs for the topic it just made. */
  topic: TopicPiece;
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

/** Private UI projection. Public consumers retain TopicCrossref's deployed
 * piece-valued schema; navigation uses durable fid/title snapshots. */
interface TopicCrossrefView extends TopicCrossref {
  refsOutLinks: TopicNavigationLink[];
  referencedByLinks: TopicNavigationLink[];
}

/** A sibling topic as the index carries it: the piece reference itself
 * (stored as a link to the child) declared through a title-only schema.
 * The declared schema is the bound — schemas filter visibility, so a reader
 * following an index edge through this type cannot expand the sibling's
 * body, thread, or verbs. No pattern-authored fid fields: rendering a
 * reference as an address is the CLI's job (decision 6, F2). */
export interface TopicIndexRef {
  title: string;
}

/** One row of the board's compact discovery index: the child reference plus
 * scalar summaries and the prose reference edges as sibling references.
 * The count/activity scalars are plain numbers — the computed coalesces a
 * cold or older sibling's absent path to 0, so the row itself never carries
 * the mixed-version undefined. `createdBy` keeps TopicReference's shaping:
 * authorship has no honest zero, so absence stays declared. */
export interface TopicIndexRow {
  topic: TopicIndexRef;
  title: string;
  createdAt: number;
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  commentCount: number;
  lastActivityAt: number;
  /** Sibling topics whose fids this topic's prose mentions. */
  refsOut: TopicIndexRef[];
  /** Sibling topics whose prose mentions this topic's fid. */
  referencedBy: TopicIndexRef[];
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
  /** Compact discovery index — the documented full-board survey surface: one
   * reference-plus-summary row per (non-null) entry of `topics`. Everything
   * reference-valued in a row is declared through the title-only
   * `TopicIndexRef`, so one bounded read surveys the whole board.
   * `crossrefs` stays as the UI's reference graph; it is not compact — each
   * row expands to full pieces — and is not the survey surface. */
  index: TopicIndexRow[] | Default<[]>;
  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle?: PerSession<Writable<string>>;
  addTopic: Stream<AddTopicEvent, AddTopicResult>;
  /** @deprecated Compatibility view for callers of the previous board. */
  myName: string;
  /** @deprecated Compatibility mutation for callers of the previous board. */
  setMyName: Stream<{ name: string }>;
  /** Submit the footer composer as the current viewer's canonical Profile. */
  submitTopic: Stream<void>;
}

// Navigation helpers live with the shared Topic UI because the board and
// detail page render the same durable links.
export { crossrefLinkRow, topicCellLink } from "./topic.tsx";

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

  const addTopic = action<AddTopicEvent, AddTopicResult>((
    { title, body, agentName },
  ) => {
    const trimmed = (title ?? "").trim();
    const author = topicAuthorFromAgent(agentName ?? "");
    if (agentName !== undefined && !author) {
      rejectMutation("addTopic", "agentName must be non-blank when given");
    }
    if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
    const legacyName = author
      ? topicAuthorLabel(author)
      : (myName.get() ?? "").trim() || "someone";
    const piece = Topic({
      title: trimmed,
      // Body at create is part of the create's atomic unit; created-with is
      // not an update, so bodyUpdatedBy/At stay unset (createdBy covers it).
      // Preserved verbatim, matching setBody and the UI save path — trimming
      // would corrupt whitespace-sensitive Markdown (indented code blocks).
      body: body ?? "",
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
    return { topic: piece };
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
  // changes and nothing derived is persisted. The private view also carries
  // fid/title snapshots so rendered navigation is durable across cold loads;
  // the public result below retains its deployed piece-valued schema.
  const crossrefView = computed(() => {
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
    const rows: TopicCrossrefView[] = [];
    list.forEach((t, i) => {
      if (!t) return;
      rows.push({
        fid: payloads[i] ? `fid1:${payloads[i]}` : "",
        topic: t,
        refsOut: refsOut[i].map((j) => list[j]),
        referencedBy: referencedBy[i].map((j) => list[j]),
        refsOutLinks: refsOut[i].map((j) => ({
          fid: payloads[j] ? `fid1:${payloads[j]}` : "",
          title: list[j]?.title ?? "",
        })),
        referencedByLinks: referencedBy[i].map((j) => ({
          fid: payloads[j] ? `fid1:${payloads[j]}` : "",
          title: list[j]?.title ?? "",
        })),
      });
    });
    return rows;
  });

  const crossrefs = computed(() =>
    crossrefView.map((row) => ({
      fid: row.fid,
      topic: row.topic,
      refsOut: row.refsOut,
      referencedBy: row.referencedBy,
    }))
  );

  // The compact discovery surface. Rows reuse the crossref join, but every
  // reference-valued field is DECLARED through the title-only TopicIndexRef,
  // so the row schema — not reader discipline — is what keeps a full-board
  // survey bounded (a live full-board read through `crossrefs` exceeded 300k
  // tokens). The summary scalars are read into the row here so a survey needs
  // no second hop to answer "what changed lately".
  const index = computed(() =>
    crossrefView.map((row) => ({
      topic: row.topic,
      title: row.topic?.title ?? "",
      createdAt: row.topic?.createdAt ?? 0,
      createdBy: row.topic?.createdBy,
      commentCount: row.topic?.commentCount ?? 0,
      lastActivityAt: row.topic?.lastActivityAt ?? 0,
      refsOut: row.refsOut,
      referencedBy: row.referencedBy,
    }))
  );

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
              // Iterate the private rows directly so card and crossref links
              // persist ordinary fid data instead of scheduler event streams.
              const rows = crossrefView;
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
                          {t.commentCount ?? 0} comments · by{" "}
                          {topicAuthorLabel(t.createdBy, t.createdByName)} ·
                          {" "}
                          {whenLabel(t.lastActivityAt ?? 0)}
                        </cf-text>
                        {crossrefLinkRow(
                          "references →",
                          row.refsOutLinks,
                        )}
                        {crossrefLinkRow(
                          "← referenced by",
                          row.referencedByLinks,
                        )}
                      </cf-vstack>
                      {topicCellLink(row.fid, "Open")}
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
    index,
    newTitle,
    addTopic,
    myName: myNameView,
    setMyName,
    submitTopic,
  };
});
