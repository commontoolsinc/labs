import {
  action,
  Default,
  entityRefToString,
  handler,
  lift,
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
  fidPayload,
  rejectMutation,
  snippet,
  type TopicAuthor,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  topicCellLink,
  type TopicPiece,
  TOPICS_THEME,
  type TopicSummary,
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
  TopicOutput,
  TopicPiece,
  TopicSummary,
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
   * renders as an address (`cf piece call --show-links`), so a create needs no
   * authored fid field of its own — unlike an index row, which is read through
   * `cf piece get` and has no such flag. A caller therefore addresses the new
   * topic straight from the create, instead of filing it and then searching
   * the board's index for the topic it just made. */
  topic: TopicPiece;
}

/** One board row as the board itself holds it: the topic's canonical address,
 * the topic, and the scalars a survey and a card both read.
 *
 * Private to the board. Nothing published is shaped by it — `index` republishes
 * these rows through the tighter `TopicIndexRow`, and the card list reads them
 * through `TopicCard` — which is what leaves `topic` free to be the whole piece
 * here. It is a link, and each reader's own declared schema decides what that
 * link resolves to. */
interface TopicRow {
  /** The topic's own fid in tagged form (`fid1:…`); "" until known. */
  fid: string;
  topic: TopicPiece;
  title: string;
  createdAt: number;
  /** Authorship has no honest zero, so absence stays declared rather than
   * being coalesced to an empty author. */
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  /** Coalesced to 0 for a cold or older topic whose derived path is absent,
   * so the row itself never carries the mixed-version undefined. */
  commentCount: number;
  lastActivityAt: number;
}

/** A topic as the compact index carries it: the child reference itself declared
 * through a title-only schema. The declared schema is the bound, so a reader
 * surveying the board cannot expand a topic's prose through this at all. */
export interface TopicIndexRef {
  title: string;
}

/** One row of the board's compact discovery index — the same rows the cards
 * render, declared through the tighter `TopicIndexRef` so one bounded read
 * surveys the whole board. */
export interface TopicIndexRow {
  /** The topic's canonical address in tagged form (`fid1:…`); "" until known.
   *
   * The row's `topic` is the reference itself, and `cf piece get --select
   * topic@` resolves that reference's own address — so this field is a
   * convenience rather than the only way through. It earns its place by
   * composing with `--filter`, which `@` does not: a filtered array's survivors
   * no longer say which positions they came from, so finding one topic by title
   * and learning its address is one read with this field and two without.
   *
   * Derived from runtime-only cell surface, so it reads "" for a topic whose
   * own entity has not resolved yet. */
  fid: string;
  topic: TopicIndexRef;
  title: string;
  createdAt: number;
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  commentCount: number;
  lastActivityAt: number;
}

/**
 * The board's rows, one per (non-null) topic. Identity is each entry's resolved
 * result-doc fid, and nothing here is persisted.
 *
 * A `lift` rather than a pattern-body derivation because the declared parameter
 * type is what bounds the read: `TopicSummary` is a title and four scalars, so
 * building every row on the board expands no topic's body, thread, verbs, or
 * rendered UI. An inferred input schema would read each topic whole.
 *
 * HACK: the parameter reads `TopicSummary` but each row's `topic` is declared
 * `TopicPiece`, via an `as`. A reference the lift passes through is a link, and
 * a link resolves to the whole topic no matter how little of it this lift
 * declared — so the cast describes what the row actually holds, while the
 * narrow parameter still bounds what this derivation reads. Both readers of a
 * row need that: `index` projects the link title-only, and a card reads a body
 * snippet and the legacy author name through the same link. Generic lifts that
 * carried an input reference type through to the output would say this without
 * a cast.
 */
const boardRows = lift(
  (topics: Writable<TopicSummary[] | Default<[]>>): TopicRow[] => {
    const list = topics.get();
    // Each entry's own fid payload ("" while unresolved, e.g. mid-sync).
    // resolveAsCell/entityId are cell-runtime surface, not on the pattern
    // Writable type (same cast as notes' appendLink).
    const payloads = list.map((t, i) => {
      if (!t) return "";
      const ref = (topics.key(i) as any).resolveAsCell?.()?.entityId;
      return ref ? fidPayload(entityRefToString(ref)) : "";
    });
    // Built as `unknown[]` because what goes in is a cell and what a reader
    // receives is the row: the array holds links, and the declared result type
    // is what a consumer resolves them to. Same shape as the `as TopicPiece`
    // cast on the reference below, which TypeScript expresses directly only
    // because those types are structurally related and `Cell<T>`/`T` are not.
    const rows: unknown[] = [];
    list.forEach((t, i) => {
      if (!t) return;
      // Each row goes in a cell caused by the topic it describes, and the array
      // holds a LINK to that cell rather than the row inline. That is what the
      // `map` builtin keys element runs by: it reads each element's normalized
      // link, so a link resolves to the row's own entity and stays the same
      // wherever the row sits, while an inline value resolves to the array
      // position and makes identity positional. The board sorts by activity, so
      // every append is a prepend — inline rows re-key every card and rebuild
      // its whole subtree; linked rows keep theirs and the run is reused.
      //
      // A topic whose fid has not resolved yet (mid-sync) has no stable cause,
      // so it falls back to its position — positional identity for exactly the
      // rows that have no identity yet, which is what they have today anyway.
      const cause = payloads[i] ? payloads[i] : ["unresolved-topic-row", i];
      rows.push(
        Writable.for<TopicRow>(cause).set({
          fid: payloads[i] ? `fid1:${payloads[i]}` : "",
          topic: t as TopicPiece,
          title: t.title,
          createdAt: t.createdAt,
          createdBy: t.createdBy,
          commentCount: t.commentCount ?? 0,
          lastActivityAt: t.lastActivityAt ?? 0,
        }),
      );
    });
    return rows as TopicRow[];
  },
);

/** Exactly what one board card renders. Its `topic` is a two-field projection
 * of the row's reference — the body snippet and the legacy author name — so a
 * card can never expand a topic beyond those. Private to the board; nothing
 * published is shaped by it, which is what leaves it free to be this narrow. */
interface TopicCard {
  // Every field carries a default. The board's card list is lowered to a
  // mapped sub-pattern, so this is the argument schema a piece holding rows
  // written by an older version of this pattern gets updated against — and a
  // required property that its stored rows lack refuses the update outright
  // (`deno task pattern-vintage` catches exactly that).
  //
  // `TopicRow` satisfies this structurally. Declaring it separately is what
  // stops ordering the board from carrying a whole-piece row schema.
  fid: string | Default<"">;
  title: string | Default<"">;
  topic: {
    body: string | Default<"">;
    createdByName: string | Default<"">;
  };
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  commentCount: number | Default<0>;
  lastActivityAt: number | Default<0>;
}

/**
 * The board's cards, most recently active first.
 *
 * Sorts and returns the rows themselves. It does not build a card object per
 * row, and that is the point: a constructed object is a new value with no
 * identity, so every render would hand the mapped sub-pattern fresh content
 * and every card's subtree would be re-addressed — new scheduler actions
 * registered and the old ones torn down — for rows whose content never
 * changed. Passing a row through keeps the identity it already has.
 *
 * Separate from `boardRows` so the published index keeps the board's own order
 * while the cards carry activity order.
 */
const cardsByActivity = lift((rows: TopicCard[]): TopicCard[] =>
  rows.toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
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
  /** The full-board survey surface: one bounded row per topic, carrying its
   * canonical address, its reference, and the scalars a survey reads. Rows
   * carry their own `fid`, so consumers never correlate by position — an index
   * into this array is not a stable address. */
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

// The navigation helper lives with the shared Topic module, beside the fid
// helper it pairs with.
export { topicCellLink } from "./topic.tsx";

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
    // mention universe the new topic's editor autocompletes over.
    mentionable,
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
  const rows = boardRows(topics);
  const cards = cardsByActivity(rows);
  const hasNoTopics = rows.length === 0;

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
                    {card.topic.body
                      ? (
                        <cf-text tone="muted" block truncate>
                          {snippet(card.topic.body, 120)}
                        </cf-text>
                      )
                      : null}
                    <cf-text variant="caption" tone="muted">
                      {card.commentCount} comments · by {topicAuthorLabel(
                        card.createdBy,
                        card.topic.createdByName,
                      )}
                      {" · "}
                      {whenLabel(card.lastActivityAt)}
                    </cf-text>
                  </cf-vstack>
                  {topicCellLink(card.fid, "Open")}
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
    index: rows,
    newTitle,
    addTopic,
    myName,
    setMyName,
    submitTopic,
  };
});
