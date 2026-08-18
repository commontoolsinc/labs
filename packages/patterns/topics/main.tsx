import {
  action,
  Default,
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

import Topic, {
  rejectMutation,
  snippet,
  type TopicAuthor,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  type TopicCrossrefRow,
  type TopicMentionSource,
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
  TopicCrossrefRow,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicMentionRef,
  TopicMentionRefMap,
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
   * renders as an address (`cf call --show-links`). A caller therefore
   * addresses the new topic straight from the create, instead of filing it and
   * then searching the board's index for the topic it just made. */
  topic: TopicPiece;
}

/** One row of the board's compact discovery index: the topic itself, declared
 * through a title-and-scalars schema. The declared schema is the bound, so a
 * reader surveying the board expands no topic's prose, thread, or verbs.
 *
 * A row IS the topic it describes, so a row's own address is the topic's
 * address; nothing here carries a separate copy of it. */
export interface TopicIndexRow {
  title: string;
  createdAt: number;
  /** Authorship has no honest zero, so absence stays declared rather than
   * being coalesced to an empty author. */
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  /** Coalesced to 0 for a cold or older topic whose derived path is absent,
   * so the row itself never carries the mixed-version undefined. */
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
}

/**
 * The board's mention pivot: one row per topic, naming the topics that mention
 * it.
 *
 * The whole reference graph is derived HERE, once, and every topic reads its
 * own row out of the result. The alternative — each topic deriving its own
 * inbound edges — is the same join done N times over the same corpus.
 *
 * The declared parameter is the entire cost of that: one list of references per
 * topic, `unknown` because they are compared by identity and never read
 * through. So the pivot over a whole board expands no topic's title, prose,
 * thread, verbs, or rendered UI. It reads the shape of the graph and nothing
 * else.
 *
 * Matching is a linear scan of `.equals` rather than a lookup keyed by id, and
 * that is the point rather than a concession: a cell reference is the identity,
 * so there is no id to key by and none has to be minted, kept in step, or
 * migrated when a piece moves. At board scale the scan is O(topics × mentions)
 * comparisons of already-resolved links, which is nothing.
 *
 * Each row is addressed by the topic it describes — `Writable.for(topic)` — so
 * a row keeps its identity wherever it sits in the array and however the board
 * is reordered. That is what lets every topic's lookup lift re-run freely on
 * any board change and still write nothing: an unchanged row recomputes to the
 * same links at the same address.
 */
const crossrefTable = lift(
  (
    { sources }: {
      // An array of CELLS, which is what lets ONE declaration answer both of
      // the pivot's questions: the cell is the topic's identity, and its value
      // is the short list of what that topic points at. A cell always writes as
      // a link, so the rows below are deterministic; an element read as a value
      // writes a link only while it still carries provenance and an inline copy
      // once it does not, which makes the same inputs produce two different
      // documents and fails the idempotency recheck.
      sources: ReadonlyCell<TopicMentionSource>[] | Default<[]>;
    },
  ): TopicCrossrefRow[] => {
    const rows: unknown[] = [];
    // Both passes below are over a plain array. The scan is quadratic, and an
    // element read through the reactive array resolves a link every time, so
    // reading it there costs a link resolution per topic per topic.
    const list = Array.from(sources);
    // Each topic's mention list, read once, for the same reason.
    const mentions = list.map((topic) => topic?.get().mentions);
    list.forEach((topic) => {
      // An entry with nothing behind it yet (mid-sync) has no identity to
      // address a row by, and `Writable.for(undefined)` is not a cause. It gets
      // no row rather than a junk one — the lookup is by identity, not by
      // position, so a shorter table costs nothing.
      if (!topic) return;
      // A linear scan, deliberately. A cell reference is the identity, so there
      // is no id to key a map by — and nothing to mint, keep in step, or
      // migrate when a piece moves. At board scale this is a few hundred
      // comparisons of already-resolved links.
      const mentionedBy = list.filter((other, from) =>
        // A topic mentioning itself is not an edge, the rule a self-link has
        // always had here — asked of the topic rather than of its position, so
        // a board listing one topic twice cannot route a self-mention through
        // the twin and call it an inbound edge.
        !equals(other, topic) &&
        // `equals` resolves BOTH sides before comparing, so it returns "do
        // these name the same document" whether each side arrived as a cell or
        // as the raw link a read left behind. A method call on the value would
        // depend on which of those it happens to be.
        mentions[from]?.some((mention) => equals(mention, topic))
      );
      // Addressed by the topic it describes, so a row keeps its identity
      // wherever it sits and however the board is reordered. That is what lets
      // every topic's lookup re-run freely on any board change and still write
      // nothing: an unchanged row recomputes to the same links at the same
      // address.
      rows.push(
        Writable.for<TopicCrossrefRow>(topic).set({ topic, mentionedBy }),
      );
    });
    return rows as TopicCrossrefRow[];
  },
);

/**
 * The board's cards, most recently active first.
 *
 * Sorts and returns the topics themselves. It does not build a card object per
 * topic, and that is the point: a constructed object is a new value with no
 * identity, so every render would hand the mapped sub-pattern fresh content
 * and every card's subtree would be re-addressed — new scheduler actions
 * registered and the old ones torn down — for topics whose content never
 * changed. Passing a topic through keeps the identity it already has.
 *
 * The CONSTRAINT declares the one field the sort reads, so ordering the board
 * expands no topic; the type parameter hands back what it was given, which is
 * the topics themselves. Those are two separate statements, and a cast could
 * only conflate them — the one here used to claim a card-shaped view the sort
 * never produced, which also hid `lastActivityAt`'s absence from the caller.
 *
 * Each card still bounds its own read: the elements are links, and the mapped
 * sub-pattern's argument schema is shrunk to the fields its body renders. That
 * schema is why every field a card touches carries a default — it is what a
 * piece holding older topics is updated against.
 */
const cardsByActivity = lift(
  <T extends { lastActivityAt: number | Default<0> | undefined }>(
    { rows }: { rows: T[] | Default<[]> },
  ): T[] =>
    rows.toSorted((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
);

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
  /** The board's mention pivot, one row per topic: the topic, and the topics
   * that mention it. Published so a topic composed outside `addTopic` can be
   * wired to the same table the board's own children read — the graph is
   * derived once, here, and never per topic. */
  crossrefs: TopicCrossrefRow[] | Default<[]>;
  /** The full-board survey surface: one bounded row per topic, carrying the
   * scalars a survey reads. A row IS its topic, so a row's own address is the
   * topic's — `--select index[].@` reads it, and an index into this array is
   * not a stable address. */
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

/** Browser composer submit. Profile wishes are resolved by the pattern and
 * bound into this handler as plain snapshot values, which keeps the mutation
 * independently testable without weakening the canonical Profile path. */
export const submitProfileTopic = handler<void, {
  topics: Writable<TopicPiece[] | Default<[]>>;
  mentionable: Writable<TopicPiece[] | Default<[]>>;
  /** `Writable` only because that is what the factory boundary accepts: the
   * input this is handed straight to declares `ReadonlyCell`, and a
   * `ReadonlyCell` held in handler state is not assignable to it — handler
   * state keeps a cell whole while `StripCell` unwraps the input's. Nothing
   * here writes a row. */
  boardCrossrefs: Writable<TopicCrossrefRow[] | Default<[]>>;
  newTitle: Writable<string>;
  myName: Writable<string | Default<"">>;
  profileName: string;
  profileAvatar: string;
}>((_, {
  topics,
  mentionable,
  boardCrossrefs,
  newTitle,
  myName,
  profileName,
  profileAvatar,
}) => {
  const trimmed = newTitle.get().trim();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!trimmed || !author) return;
  const piece = Topic({
    title: trimmed,
    createdAt: Date.now(),
    createdBy: author,
    createdByName: topicAuthorLabel(author),
    myName,
    // Same wiring `addTopic` gives its children: the board's own list is the
    // mention universe the new topic's editor autocompletes over, and the
    // board's pivot is where it reads its inbound references.
    mentionable,
    boardCrossrefs,
  });
  topics.push(piece);
  newTitle.set("");
});

export default pattern<TopicsInput, TopicsOutput>(({ topics, myName }) => {
  const newTitle = new Writable.perSession("");

  // `.length` alone is what makes this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no topic. Reaching past
  // `.length` — or through a helper this analysis cannot see into — is what
  // puts the whole board back in the read.
  const topicCount = topics.get().length;
  const cards = cardsByActivity({ rows: topics });
  // Derived once for the whole board; every topic reads its own row out of it.
  const crossrefs = crossrefTable({ sources: topics });
  const hasNoTopics = topicCount === 0;

  // Browser authorship comes from the current viewer's canonical Profile.
  // CLI streams below remain wish-free: agents sign each mutation in the
  // event payload, while Fabric records the human principal behind the key.
  // One wish, not three: `#profile` resolves the profile itself, and `name`
  // and `avatar` are fields on it. The `#profileName` / `#profileAvatar`
  // targets are the same two fields reached through a second and third
  // resolution of the same profile.
  const profileWish = wish<{ name: string; avatar: string }>({
    query: "#profile",
  });
  // A wish resolves after setup, so each of these stays a derivation. Reading
  // the fields once here would pin the composer to the empty profile the board
  // started with: the Start button never enables, and a topic filed through it
  // carries blank attribution.
  const profileName = profileWish.result?.name ?? "";
  const profileAvatar = profileWish.result?.avatar ?? "";
  const hasProfile = profileName.trim().length > 0;

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
      : myName.get().trim() || "someone";
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
      // The board's own list, so the editor has a mention universe (backfilled
      // as a one-time link-bind on pieces created before this input existed).
      mentionable: topics,
      // The board's mention pivot. A topic reads its inbound references out of
      // the row the board already built for it rather than rebuilding the join.
      boardCrossrefs: crossrefs,
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
    boardCrossrefs: crossrefs,
    newTitle,
    myName,
    profileName,
    profileAvatar,
  });

  return {
    [NAME]: `Topics (${topicCount})`,
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
            {cards.map((card) => (
              <cf-card>
                <cf-hstack gap="3" align="center">
                  <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                    <cf-text block style="font-weight: 600;">
                      {card.title || "(untitled topic)"}
                    </cf-text>
                    {card.body
                      ? (
                        <cf-text tone="muted" block truncate>
                          {snippet(card.body, 120)}
                        </cf-text>
                      )
                      : null}
                    <cf-text variant="caption" tone="muted">
                      {card.commentCount} comments · by {topicAuthorLabel(
                        card.createdBy,
                        card.createdByName,
                      )}
                      {" · "}
                      {whenLabel(card.lastActivityAt ?? 0)}
                    </cf-text>
                  </cf-vstack>
                  <cf-cell-link $cell={card} label="Open" static />
                </cf-hstack>
              </cf-card>
            ))}

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
                disabled={!hasProfile}
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
    // The topics themselves, declared through the index's narrow row schema:
    // a row's address is the topic's address, so a survey and a follow-up read
    // name the same document.
    index: topics,
    newTitle,
    addTopic,
    myName,
    setMyName,
    submitTopic,
  };
});
