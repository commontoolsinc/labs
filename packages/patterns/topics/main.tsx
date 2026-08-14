import {
  action,
  type ComparableCell,
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
  type TopicCrossrefs,
  type TopicNavigationLink,
  type TopicPiece,
  TOPICS_THEME,
  type TopicScan,
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
  TopicScan,
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

/** One topic's place in the prose reference graph, plus the scalars a survey
 * needs and the durable fid/title snapshots rendered navigation needs.
 *
 * Derived at read time from fids pasted in bodies, comments, and link URLs —
 * never persisted, so a partial-view replica can never destroy real edges (the
 * failure class of index patterns that write backlinks into their targets).
 *
 * Everything reference-valued is declared through `TopicScan`: the row schema —
 * not reader discipline — is what keeps a full-board survey bounded. A reader
 * following an edge from here reaches a sibling's prose and counts, never its
 * verbs or its rendered UI. */
export interface TopicCrossref {
  /** The topic's own fid in tagged form (`fid1:…`); "" until known. */
  fid: string;
  topic: TopicPiece;
  title: string;
  createdAt: number;
  /** Authorship has no honest zero, so absence stays declared rather than
   * being coalesced to an empty author. */
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  /** Coalesced to 0 for a cold or older sibling whose derived path is absent,
   * so the row itself never carries the mixed-version undefined. */
  commentCount: number;
  lastActivityAt: number;
  /** Sibling topics whose fids this topic's prose mentions. */
  refsOut: TopicPiece[];
  /** Sibling topics whose prose mentions this topic's fid. */
  referencedBy: TopicPiece[];
  /** The same two edge sets as durable fid/title snapshots, so rendered
   * navigation survives a cold load without resolving a sibling. */
  refsOutLinks: TopicNavigationLink[];
  referencedByLinks: TopicNavigationLink[];
}

/** A sibling topic as the compact index carries it: the child reference itself
 * declared through a title-only schema. The declared schema is the bound, so a
 * reader following an index edge cannot expand the sibling's prose at all. No
 * pattern-authored fid fields: rendering a reference as an address is the CLI's
 * job (decision 6, F2). */
export interface TopicIndexRef {
  title: string;
}

/** One row of the board's compact discovery index — the same rows `crossrefs`
 * carries, declared through the tighter `TopicIndexRef` so one bounded read
 * surveys the whole board. */
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
 * The prose reference graph over the board's own topics, one row per (non-null)
 * entry. Recomputed from the whole corpus on any board change (O(topics × text)
 * — trivial at board scale; the growth path is per-topic memoization). Identity
 * is each entry's resolved result-doc fid, so the existing corpus lights up with
 * zero authoring changes and nothing derived is persisted.
 *
 * A `lift` rather than a pattern-body derivation because the declared parameter
 * type is what bounds the read: the body calls helpers this schema analysis
 * cannot see through (`topicCorpus`, `crossrefJoin`), and an inferred input
 * schema would fall back to reading every topic whole — verbs, thread, and
 * rendered UI included.
 *
 * HACK: the parameter reads `TopicScan` but the rows publish `TopicPiece`, via
 * an `as` on each reference. A reference the lift passes through is a link, and
 * a link resolves to the whole topic no matter how little of it this lift
 * declared — so the cast describes what a consumer actually receives, and the
 * narrow parameter still bounds what this derivation reads. TypeScript cannot
 * express that on its own here: a lift's parameter and result are one type, so
 * without the cast, narrowing the read would also narrow the published
 * `crossrefs` edge targets and remove result fields consumers were promised
 * (`deno task pattern-compat` rejects exactly that). Generic lifts that carry
 * an input reference type through to the output would remove the need for it.
 */
const crossrefRows = lift(
  (
    { scan, identities }: {
      scan: Writable<TopicScan[] | Default<[]>>;
      // The SAME array, declared a second time as cells. The edge sets below
      // hold REFERENCES to siblings, and a cell always writes as a link; an
      // element read as a value writes a link only while it still carries
      // provenance and an inline copy once it does not, so the same inputs
      // would produce two different documents and fail the idempotency
      // recheck. Reading identity and prose through separate declarations is
      // what lets each stay minimal.
      identities: Writable<ComparableCell<unknown>[] | Default<[]>>;
    },
  ): TopicCrossref[] => {
    const list = scan.get();
    const cells = identities.get();
    // Each entry's own fid payload ("" while unresolved, e.g. mid-sync — such
    // entries simply hold no edges this render). resolveAsCell/entityId are
    // cell-runtime surface, not on the pattern Writable type (same cast as
    // notes' appendLink).
    const payloads = list.map((t, i) => {
      if (!t) return "";
      const ref = (scan.key(i) as any).resolveAsCell?.()?.entityId;
      return ref ? fidPayload(entityRefToString(ref)) : "";
    });
    const { refsOut, referencedBy } = crossrefJoin(
      list.map((t) => topicCorpus(t)),
      payloads,
    );
    // Built as `unknown[]` because what goes in is a cell and what a reader
    // receives is the row: the array holds links, and the declared result type
    // is what a consumer resolves them to. Same shape as the `as TopicPiece`
    // casts on the references below, which TypeScript expresses directly only
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
        Writable.for<TopicCrossref>(cause).set({
          fid: payloads[i] ? `fid1:${payloads[i]}` : "",
          topic: t as TopicPiece,
          title: t.title,
          createdAt: t.createdAt,
          // Copied as a VALUE, not passed through: an object handed straight
          // from a read into `.set()` writes a link while it carries
          // provenance and an inline copy once it does not, and a row is a
          // snapshot of the scalars a survey summarises anyway.
          createdBy: t.createdBy ? { ...t.createdBy } : undefined,
          commentCount: t.commentCount ?? 0,
          lastActivityAt: t.lastActivityAt ?? 0,
          // Built as `unknown[]` and asserted once, the same shape the `rows`
          // array uses: what goes in is a cell and what a consumer resolves is
          // the topic behind it.
          refsOut: refsOut[i].map((j) => cells[j]) as unknown[] as TopicPiece[],
          referencedBy: referencedBy[i].map((j) =>
            cells[j]
          ) as unknown[] as TopicPiece[],
          refsOutLinks: refsOut[i].map((j) => ({
            fid: payloads[j] ? `fid1:${payloads[j]}` : "",
            title: list[j].title,
          })),
          referencedByLinks: referencedBy[i].map((j) => ({
            fid: payloads[j] ? `fid1:${payloads[j]}` : "",
            title: list[j].title,
          })),
        }),
      );
    });
    return rows as TopicCrossref[];
  },
);

/** Exactly what one board card renders. Carries no piece reference at all: the
 * cards navigate through the durable fid/title snapshots, so they never need
 * the reference itself. Private to the board — nothing published is shaped by
 * it, which is what leaves it free to be this narrow. */
interface TopicCard {
  // Every field carries a default. The board's card list is lowered to a
  // mapped sub-pattern, so this is the argument schema a piece holding rows
  // written by an older version of this pattern gets updated against — and a
  // required property that its stored rows lack refuses the update outright
  // (`deno task pattern-vintage` catches exactly that).
  //
  // `TopicCrossref` satisfies this structurally. Declaring it this way is what
  // stops ordering the board from carrying a reference-bearing row schema:
  // `topic` is a two-field projection, so a card reads prose and scalars and
  // can never expand a sibling, while `TopicCrossref`'s reference fields stay
  // available to consumers of the published result.
  fid: string | Default<"">;
  title: string | Default<"">;
  topic: {
    body: string | Default<"">;
    createdByName: string | Default<"">;
  };
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  commentCount: number | Default<0>;
  lastActivityAt: number | Default<0>;
  refsOutLinks: TopicNavigationLink[] | Default<[]>;
  referencedByLinks: TopicNavigationLink[] | Default<[]>;
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
 * Separate from `crossrefRows` so the published rows keep the board's own
 * order while the cards carry the board's.
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
  /** The prose reference graph. Rows carry their topic, so consumers never
   * need to correlate by index — indices are not a stable address. */
  crossrefs: TopicCrossref[] | Default<[]>;
  /** The documented full-board survey surface: the same rows as `crossrefs`,
   * declared through the tighter title-only reference type. */
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
  boardCrossrefs: Writable<TopicCrossrefs[] | Default<[]>>;
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
    mentionable,
    // Same wiring `addTopic` gives its children. Without it a topic composed
    // in the browser — which is most of them — derives `referencedBy` from the
    // whole corpus locally, so the read bound this pattern is built around
    // would apply only to topics an agent created.
    boardCrossrefs,
  });
  topics.push(piece);
  newTitle.set("");
});

export default pattern<TopicsInput, TopicsOutput>(({ topics, myName }) => {
  const newTitle = new Writable.perSession("");

  // Declared before the mutation actions: `addTopic` passes `rows` to each
  // child it creates, and a const referenced from an action closure must be
  // initialized by the time the pattern body finishes building it.
  // `.length` alone is what makes this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no topic. Reaching past
  // `.length` — or through a helper this analysis cannot see into — is what
  // puts the whole board back in the read.
  const topicCount = topics.get().length;
  const rows = crossrefRows({ scan: topics, identities: topics });
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
      // The board's own list, so the detail page can derive its connections
      // and the editor has a mention universe (backfilled as a one-time
      // link-bind on pieces created before this input existed).
      mentionable: topics,
      // The board's computed graph. A topic reads its inbound edges out of the
      // row the board already built for it rather than rebuilding the join.
      boardCrossrefs: rows,
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
    boardCrossrefs: rows,
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
                    {crossrefLinkRow("references →", card.refsOutLinks)}
                    {crossrefLinkRow("← referenced by", card.referencedByLinks)}
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
    crossrefs: rows,
    index: rows,
    newTitle,
    addTopic,
    myName,
    setMyName,
    submitTopic,
  };
});
