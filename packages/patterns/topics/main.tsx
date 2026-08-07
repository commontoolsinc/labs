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
  (topics: Writable<TopicScan[] | Default<[]>>): TopicCrossref[] => {
    const list = topics.get();
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
        topic: t as TopicPiece,
        title: t.title,
        createdAt: t.createdAt,
        createdBy: t.createdBy,
        commentCount: t.commentCount ?? 0,
        lastActivityAt: t.lastActivityAt ?? 0,
        refsOut: refsOut[i].map((j) => list[j] as TopicPiece),
        referencedBy: referencedBy[i].map((j) => list[j] as TopicPiece),
        refsOutLinks: refsOut[i].map((j) => ({
          fid: payloads[j] ? `fid1:${payloads[j]}` : "",
          title: list[j].title,
        })),
        referencedByLinks: referencedBy[i].map((j) => ({
          fid: payloads[j] ? `fid1:${payloads[j]}` : "",
          title: list[j].title,
        })),
      });
    });
    return rows;
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
  fid: string | Default<"">;
  title: string | Default<"">;
  body: string | Default<"">;
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  createdByName: string | Default<"">;
  commentCount: number | Default<0>;
  lastActivityAt: number | Default<0>;
  refsOutLinks: TopicNavigationLink[] | Default<[]>;
  referencedByLinks: TopicNavigationLink[] | Default<[]>;
}

/** The fields of a crossref row that a card is built from. `TopicCrossref`
 * satisfies this structurally; declaring the parameter this way is what stops
 * ordering the board from carrying a reference-bearing row schema. */
interface TopicCardSource {
  fid: string;
  title: string;
  topic: { body: string; createdByName: string };
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;
  commentCount: number;
  lastActivityAt: number;
  refsOutLinks: TopicNavigationLink[];
  referencedByLinks: TopicNavigationLink[];
}

/**
 * The board's cards, most recently active first.
 *
 * Separate from `crossrefRows` so the published rows keep the board's own
 * order, and declared over `TopicCardSource`/`TopicCard` rather than over
 * `TopicCrossref` so neither the sort nor the render carries a schema that can
 * expand a sibling. `TopicCrossref`'s reference fields exist for consumers of
 * the published result; a card reads prose and scalars and never follows one.
 */
const cardsByActivity = lift((rows: TopicCardSource[]): TopicCard[] =>
  rows
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((row) => ({
      fid: row.fid,
      title: row.title,
      body: row.topic.body,
      createdBy: row.createdBy,
      createdByName: row.topic.createdByName,
      commentCount: row.commentCount,
      lastActivityAt: row.lastActivityAt,
      refsOutLinks: row.refsOutLinks,
      referencedByLinks: row.referencedByLinks,
    }))
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

  // `.length` alone is what makes this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no topic. Reaching past
  // `.length` — or through a helper this analysis cannot see into — is what
  // puts the whole board back in the read.
  const topicCount = topics.get().length;
  const rows = crossrefRows(topics);
  const cards = cardsByActivity(rows);
  const hasNoTopics = rows.length === 0;

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
                      {card.commentCount} comments · by{" "}
                      {topicAuthorLabel(card.createdBy, card.createdByName)}
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
