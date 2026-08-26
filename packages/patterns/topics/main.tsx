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
  SetTitleEvent,
  SetTitleResult,
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

/**
 * What the board USES of a stored topic — its demand, not the topic's truth.
 *
 * Written by the consumer, which is the point: a holder writes down what it
 * reads or writes and the verbs it calls, never what the other pattern IS
 * ([designing verbs so they can change](../../../docs/plans/verb-evolution.md),
 * "a holder demands only what it uses"). This board calls NO topic verb, so
 * its demand names none — and once it names none, adding a verb to a topic
 * stops touching the board's shape at all.
 *
 * That is what keeps a verb NON-OPTIONAL. The alternative, and the reason
 * this type exists, is that a verb reachable through the board's projection
 * has to be declared optional there — a stream cannot carry a default, so
 * optional is the only form an older generation tolerates — and every
 * consumer then pays a maybe at the call site, whose obvious spelling
 * (`piece.verb?.send(...)`) skips in silence.
 *
 * The membership, measured rather than guessed. Seven fields the board
 * READS: the card list renders `title`, `body`, `commentCount`, `createdBy`
 * and `lastActivityAt`; `index` publishes `title`,
 * `createdAt`, `createdBy`, `commentCount`, `lastActivityAt` — the same
 * array declared through a narrower row schema, which is why a field it
 * names has to be demanded here to resolve at all; `crossrefTable` joins on
 * `mentions`; `cardsByActivity` sorts on `lastActivityAt`; `topicCount`
 * reads only a length.
 *
 * Eight members, then, because `[NAME]` is demanded for a reason none of
 * those readers show: the board hands this same array on as each topic's
 * mention universe, so the name has to survive the demand to reach the
 * editor. Counting only what the board reads is what nearly dropped it.
 * No verbs.
 *
 * `createdByName` is deliberately NOT among them, though the card once read
 * it. It is `topicAuthorLabel`'s fallback for a topic written before
 * structured authorship, and every one of the deployed board's 113 topics
 * carries a structured `createdBy.name`, so the fallback is reached by none
 * of them. Demanding it would write a field this plan retires into the one
 * schema that cannot drop it later.
 *
 * Every field carries a default, and that is load-bearing rather than
 * stylistic: a demanded path an older topic cannot produce makes the WHOLE
 * array unreadable, while a default materializes in its place and the read
 * succeeds. Measured, not inferred.
 */
export interface TopicDemand extends TopicSummary {
  /** The display name, which the board publishes onward as each topic's
   * `mentionable` entry — and `cf-code-editor` requires it there. Dropping it
   * costs no type error and silently empties every `@`-mention completion. */
  [NAME]: string | Default<""> | undefined;
  body: string | Default<"">;
  mentions: unknown[] | Default<[]>;
}

export interface TopicsInput {
  /** The board's durable topic list. `addTopic` appends here; direct writes
   * are legitimate but unattributed, and a whole-array write forfeits the
   * mergeability the verb's append keeps. */
  topics?: Writable<TopicDemand[] | Default<[]>>;
}

export interface AddTopicEvent {
  /** The topic's title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The topic's initial living-document body. A topic born with a body
   * appears with it atomically — no reader observes the title-only halfway
   * state, and no follow-up `setBody` call is needed to finish a create
   * (verb contract: the atomic-unit rule). */
  body?: string;

  /** The agent making this mutation. The authenticated principal remains the
   * human whose identity key invoked the stream; this is the agent's explicit
   * content-level signature under that shared principal.
   *
   * Required, for the reason given on `AgentAuthoredEvent`: acceptance widens
   * compatibly and narrows only through a break, so tolerating an unsigned
   * create is a tolerance that could never be withdrawn. */
  agentName: string;
}

export interface AddTopicResult {
  /** The topic this call created — the piece itself, not a manufactured
   * identifier. It reaches the caller as a link to the child, which the CLI
   * renders as an address (`cf piece call --show-links`). A caller therefore
   * addresses the new topic straight from the create, instead of filing it and
   * then searching the board's index for the topic it just made.
   *
   * Declared through the index's row schema rather than the full `TopicPiece`,
   * and the narrowness is the contract: the declared schema bounds the default
   * readback — a full piece would expand the body, thread, and every
   * referenced sibling — and every name a verb's result publishes is permanent
   * with no gate checking it, so the result publishes the survey row the
   * caller already knows plus the write-time facts only the pattern could
   * resolve (`createdAt`, `createdBy`). */
  topic: TopicIndexRow;
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

  /** Who filed the topic. A topic written without structured authorship
   * materializes the declared default — the inert legacy sentinel
   * `{ kind: "person", name: "" }` — so a blank name here means "unsigned";
   * the display string then comes from the topic's own `createdByName`. */
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;

  /** Coalesced to 0 for a cold or older topic whose derived path is absent,
   * so the row itself never carries the mixed-version undefined. */
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
}

/**
 * Each source's mention list, read once per source.
 *
 * A source whose value has not materialized yet — a topic appended a moment
 * ago, still mid-sync — reads back as `undefined`, and taking `.mentions` of
 * that throws. Thrown here it kills the whole pivot, and with it the append
 * that caused it: the board goes on serving every topic it already had and
 * silently accepts no new one.
 *
 * `mentionedBy` below already declares this element as `| undefined` and
 * already guards it with `mentions[from]?.some(...)`. So the tolerance is not
 * being added here; the producer is being made to honor the contract its own
 * consumer states.
 *
 * A read taken straight off the cell gets no help from the compiler. `get()` on
 * `ReadonlyCell<TopicMentionSource>` is declared to return a value rather than
 * `T | undefined` — `IReadable` in `packages/api/index.ts` — so omitting the
 * second `?.` there type-checks exactly as well as including it, and every gate
 * stays green over a board that silently accepts no new topic. Only a read
 * against a board with an in-flight append tells the two apart.
 *
 * Declaring the source structurally is what changes that. The parameter type
 * says `get(): { mentions: M } | undefined`, so omitting the second `?.` HERE
 * is a compile error: `deno task cfcheck` fails with "Object is possibly
 * 'undefined'". `deno task check` passes either way — it walks the
 * hand-maintained path list in `tasks/typecheck.ts`, which this package is not
 * on, and patterns are checked by `cfcheck`. So the structural declaration buys
 * two things rather than one: the read becomes testable, and the optionality
 * moves somewhere the pattern typechecker can see it.
 *
 * Whether a cell's `get()` may return undefined against its declared type is a
 * question about the cell contract rather than about this pattern, and it is
 * not answered here.
 */
export function mentionListsOf<M>(
  sources: readonly ({ get(): { mentions: M } | undefined } | undefined)[],
): (M | undefined)[] {
  return Array.from(sources, (source) => source?.get()?.mentions);
}

/**
 * The topics that mention `topic`, out of `list` — the pivot's whole join,
 * lifted out so it can be handed a list a board cannot produce.
 *
 * `mentions[i]` is what `list[i]` points at, read once by the caller because
 * reading it through the reactive array costs a link resolution per topic per
 * topic.
 *
 * The exclusion is asked of IDENTITY, never of array position, and that is the
 * whole reason this is a named function. A board listing one topic at two
 * indices must not route its self-mention through the twin and call the result
 * an inbound edge — and a position comparison passes every test where each
 * topic appears once, which is every test a board can set up. Handing this
 * function a duplicated list is what tells the two apart.
 *
 * `equals` resolves BOTH sides before comparing, so it answers "do these name
 * the same document" whether each side arrived as a cell or as the raw link a
 * read left behind. A method call on the value would depend on which it is.
 */
export function mentionedBy<T extends object>(
  topic: T,
  list: readonly T[],
  mentions: readonly (readonly (object | undefined)[] | undefined)[],
): T[] {
  return list.filter((other, from) =>
    !equals(other, topic) &&
    mentions[from]?.some((mention) => equals(mention, topic))
  );
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
    const mentions = mentionListsOf(list);
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
      const inbound = mentionedBy(topic, list, mentions);
      // Addressed by the topic it describes, so a row keeps its identity
      // wherever it sits and however the board is reordered. That is what lets
      // every topic's lookup re-run freely on any board change and still write
      // nothing: an unchanged row recomputes to the same links at the same
      // address.
      rows.push(
        Writable.for<TopicCrossrefRow>(topic).set({
          topic,
          mentionedBy: inbound,
        }),
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
 *
 * Headless use: survey the whole board with one bounded read of `index` — a
 * row IS its topic, so a row's own address (`--select index[].@`) is what
 * that topic's reads and verbs take as the piece. File with `addTopic`,
 * title and optional initial body in one call, then work on the topic
 * directly: the body is its living document, the thread its append-only
 * deliberation. Sign every mutation with `agentName` — Fabric records the
 * human principal behind the key; the name says which agent acted under it.
 */
export interface TopicsOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The board's topics, in filing order, through the shape the board demands
   * of them: the display scalars and the mention universe, and no verbs. A
   * caller that means to mutate a topic addresses the topic itself, where its
   * own schema governs. Survey through `index` instead; read this when you
   * already know which topic you are expanding. */
  topics: TopicDemand[];
  /** The same list, under the name the topic pattern's editor autocompletes
   * over — what `addTopic` wires into each child as its mention universe. */
  mentionable: TopicDemand[] | Default<[]>;
  /** How many topics the board holds, nulls included. */
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

  /** File a topic. The atomic unit takes the initial body with the title, so
   * no reader observes a title-only halfway state and no follow-up `setBody`
   * finishes a create. Returns the created topic as its survey row — the
   * reference plus the write-time facts the pattern resolved. */
  addTopic: Stream<AddTopicEvent, AddTopicResult>;
  /** Submit the footer composer as the current viewer's canonical Profile. */
  submitTopic: Stream<void>;
}

/** Browser composer submit. Profile wishes are resolved by the pattern and
 * bound into this handler as plain snapshot values, which keeps the mutation
 * independently testable without weakening the canonical Profile path. */
export const submitProfileTopic = handler<void, {
  topics: Writable<TopicDemand[] | Default<[]>>;
  mentionable: Writable<TopicDemand[] | Default<[]>>;
  /** `Writable` only because that is what the factory boundary accepts: the
   * input this is handed straight to declares `ReadonlyCell`, and a
   * `ReadonlyCell` held in handler state is not assignable to it — handler
   * state keeps a cell whole while `StripCell` unwraps the input's. Nothing
   * here writes a row. */
  boardCrossrefs: Writable<TopicCrossrefRow[] | Default<[]>>;
  newTitle: Writable<string>;
  profileName: string;
  profileAvatar: string;
}>((_, {
  topics,
  mentionable,
  boardCrossrefs,
  newTitle,
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
    // Same wiring `addTopic` gives its children: the board's own list is the
    // mention universe the new topic's editor autocompletes over, and the
    // board's pivot is where it reads its inbound references.
    mentionable,
    boardCrossrefs,
  });
  topics.push(piece);
  newTitle.set("");
});

export default pattern<TopicsInput, TopicsOutput>(({ topics }) => {
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
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("addTopic", "agentName must be non-blank");
    if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
    const piece = Topic({
      title: trimmed,
      // Body at create is part of the create's atomic unit; created-with is
      // not an update, so bodyUpdatedBy/At stay unset (createdBy covers it).
      // Preserved verbatim, matching setBody and the UI save path — trimming
      // would corrupt whitespace-sensitive Markdown (indented code blocks).
      body: body ?? "",
      createdAt: Date.now(),
      createdBy: author,
      // The board's own list, so the editor has a mention universe (backfilled
      // as a one-time link-bind on pieces created before this input existed).
      mentionable: topics,
      // The board's mention pivot. A topic reads its inbound references out of
      // the row the board already built for it rather than rebuilding the join.
      boardCrossrefs: crossrefs,
    });
    // Mergeable append: concurrent creates from different users all land.
    // The session composer draft is `submitTopic`'s to clear; a headless
    // create has no draft.
    topics.push(piece);
    return { topic: piece };
  });

  const submitTopic = submitProfileTopic({
    topics,
    mentionable: topics,
    boardCrossrefs: crossrefs,
    newTitle,
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
    submitTopic,
  };
});
