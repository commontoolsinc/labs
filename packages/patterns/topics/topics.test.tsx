/**
 * Single-runtime pattern tests for Topics (CT-1878).
 *
 * Complements multi-user.test.tsx (cross-runtime isolation and merge
 * behavior) and topics-rejections.test.tsx (thrown rejections on the mutating
 * verbs — those runs expect runtime errors): this file drives the happy and
 * legacy paths in one runtime — atomic agent signatures, body-at-create,
 * legacy authorship fallback/shadow fields, label defaulting, body updates,
 * activity-based sorting, the derived crossref graph (edges from fids pasted
 * in bodies, comments, and link URLs; never persisted), and the exported pure
 * helpers. UI composer wrappers keep silent guards, exercised here.
 */
import {
  action,
  assert,
  Default,
  NAME,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { pattern } from "commonfabric";
import Topics, {
  crossrefLinkRow,
  submitProfileTopic,
  topicCellLink,
  type TopicPiece,
  type TopicReference,
} from "./main.tsx";
import Topic, {
  type AddCommentResult,
  type AddLinkResult,
  crossrefJoin,
  extractFidPayloads,
  fidPayload,
  isSafeLinkUrl,
  saveProfileBody,
  type SetBodyResult,
  snippet,
  submitProfileComment,
  submitProfileLink,
  type TopicAuthor,
  topicAuthorLabel,
  type TopicComment,
  topicCorpus,
  type TopicCrossrefs,
  type TopicLink,
  type TopicLinkKind,
  whenLabel,
} from "./topic.tsx";

interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

function findAllByTag(
  node: unknown,
  tag: string,
  found: TestVNode[] = [],
): TestVNode[] {
  if (Array.isArray(node)) {
    node.forEach((child) => findAllByTag(child, tag, found));
    return found;
  }
  if (!isVNode(node)) return found;
  if (node.name === tag) found.push(node);
  for (const child of node.children ?? []) findAllByTag(child, tag, found);
  return found;
}

// Compiled JSX props can be cell-backed even when the source expression was
// a plain string or boolean.
// deno-lint-ignore no-explicit-any
const propValue = (value: any): unknown =>
  value && typeof value.get === "function" ? value.get() : value;

// A faithful pre-authorship Topic projection: the legacy schema has no
// `createdBy` path at all, and its verbs declare no results. Pushing one into
// a current Topic's retained mentionable list exercises the mixed-version
// boundary that production migration must preserve.
//
// Its verbs carry the current declared arity because `Stream<E, R>`
// deliberately does not satisfy `Stream<E>` and the sibling projection is one
// contract for the whole list — verb arity is not the legacy dimension under
// test here, the absent `createdBy` path is. A genuinely older deployed
// sibling, whose verbs return nothing, stays valid against this same list at
// runtime: a declared result adds nothing to the generated schema (C3
// withdrawn — results flow schema-free through receipts), so the stored
// schema a legacy piece is validated against is unchanged.
const LegacyUnsignedTopic = pattern(() => {
  const addComment = action<{ body: string }, AddCommentResult>((event) => ({
    comment: { authorName: "", body: event.body, sentAt: 0 },
  }));
  const addLink = action<
    { kind: TopicLinkKind; url: string; label: string },
    AddLinkResult
  >((event) => ({
    link: { kind: event.kind, url: event.url, label: event.label },
  }));
  const setBody = action<{ body: string }, SetBodyResult>((event) => ({
    body: event.body,
  }));
  return {
    [NAME]: undefined,
    title: "Legacy unsigned sibling",
    body: "",
    comments: [],
    links: [],
    createdAt: 1,
    // The retained mixed-version link materializes the legacy missing path as
    // a present undefined value, which must survive current list validation.
    createdBy: undefined,
    createdByName: "Legacy Person",
    commentCount: undefined,
    lastActivityAt: undefined,
    addComment,
    addLink,
    setBody,
  };
});

export default pattern(() => {
  const board = Topics({});
  // The board stores only TopicPiece's shared-safe projection. Exercise the
  // session-local UI controls on a direct Topic instance so this test does not
  // require those narrower cells to resolve through the shared topics array.
  const directTopic = Topic({
    title: "Direct topic",
    body: "line one\nline two",
  });
  // A retained mixed-version list link can project the absent optional
  // createdBy path as an explicit undefined. Keep that sibling in a live
  // mentionable universe: the consumer must validate and derive crossrefs
  // without weakening non-empty authorship away from TopicAuthor.
  const mixedMentionable = new Writable<
    TopicReference[] | Default<[]>
  >([]);
  const mixedMentionConsumer = Topic({
    title: "Mixed mention consumer",
    mentionable: mixedMentionable,
  });

  // Branch pin for the detail derive: a piece with no `mentionable` wired
  // (the pre-rev corpus, until backfilled) derives empty connection sets.
  const lone = Topic({ title: "Lone", createdAt: 1, createdByName: "t" });
  // Pre-migration fields remain accepted and readable.
  const legacy = Topic({
    title: "Legacy",
    createdAt: 1,
    createdByName: "Legacy Person",
    comments: [{ authorName: "Old Agent", body: "old", sentAt: 2 }],
  });

  // Deterministic bindings for the exact handlers used by Profile-backed UI
  // controls. Pattern tests do not provide a #profile wish result, so bind the
  // resolved snapshot values directly here rather than inventing a production
  // fallback identity.
  const profileTopics = new Writable<TopicPiece[] | Default<[]>>([]);
  const profileBoardCrossrefs = new Writable<TopicCrossrefs[] | Default<[]>>(
    [],
  );
  const profileTitleDraft = new Writable("Profile topic");
  const profileLegacyName = new Writable<string | Default<"">>("");
  const profileComments = new Writable<TopicComment[] | Default<[]>>([]);
  const profileCommentDraft = new Writable("via the profile composer");
  const profileBody = new Writable<string | Default<"">>("old body");
  const profileBodyDraft = new Writable("profile-edited body");
  const profileEditingBody = new Writable(true);
  const profileBodyUpdatedBy = new Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >({ kind: "person", name: "" });
  const profileBodyUpdatedAt = new Writable<number | Default<0>>(0);
  const profileLinks = new Writable<TopicLink[] | Default<[]>>([]);
  const profileLinkUrlDraft = new Writable("https://example.com/profile-link");
  const profileLinkLabelDraft = new Writable("profile link");
  const profileLinkKindDraft = new Writable<TopicLinkKind>("session");
  // Render the same cells the deterministic Profile handlers mutate. This
  // keeps their behavior and the detail UI in one end-to-end test path without
  // inventing a fallback identity for the pattern-test runtime.
  const profileTopic = Topic({
    title: "Profile-authored topic",
    body: profileBody,
    comments: profileComments,
    links: profileLinks,
    bodyUpdatedBy: profileBodyUpdatedBy,
    bodyUpdatedAt: profileBodyUpdatedAt,
  });

  const profileSubmitTopic = submitProfileTopic({
    topics: profileTopics,
    mentionable: profileTopics,
    // Standalone: no board built this, so there is no computed table to read
    // and the topic it creates falls back to deriving its inbound edges
    // locally. Required rather than optional so a real composer cannot forget
    // it and silently take that fallback.
    boardCrossrefs: profileBoardCrossrefs,
    newTitle: profileTitleDraft,
    myName: profileLegacyName,
    profileName: " Ada ",
    profileAvatar: " 🦊 ",
  });
  const profileSubmitComment = submitProfileComment({
    comments: profileComments,
    commentDraft: profileCommentDraft,
    profileName: "Ada",
    profileAvatar: "🦊",
  });
  const profileSaveBody = saveProfileBody({
    body: profileBody,
    bodyDraft: profileBodyDraft,
    editingBody: profileEditingBody,
    bodyUpdatedBy: profileBodyUpdatedBy,
    bodyUpdatedAt: profileBodyUpdatedAt,
    profileName: "Ada",
    profileAvatar: "🦊",
  });
  const profileSubmitLink = submitProfileLink({
    links: profileLinks,
    linkUrlDraft: profileLinkUrlDraft,
    linkLabelDraft: profileLinkLabelDraft,
    linkKindDraft: profileLinkKindDraft,
    profileName: "Ada",
    profileAvatar: "🦊",
  });

  // --- actions ---

  const action_add_first_topic = action(() => {
    board.addTopic.send({ title: "  First topic  ", agentName: "  Sol  " });
  });
  const action_add_second_topic = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });
  // Body at create: the create's atomic unit — no reader observes a
  // title-only halfway state, and created-with is not an update (the
  // bodyUpdatedBy/At stamps stay unset; createdBy covers authorship).
  const action_add_third_topic = action(() => {
    board.addTopic.send({
      title: "Composed topic",
      body: "    indented code\nline two\n",
      agentName: "Sol",
    });
  });
  const action_link_unsigned_mixed_version_sibling = action(() => {
    mixedMentionable.push(
      LegacyUnsignedTopic({}) as TopicReference,
    );
  });

  // The previous deployed event shapes remain operational while callers
  // migrate. They use the hidden legacy name cell; new callers always send an
  // atomic `agentName` instead.
  const legacyBoard = Topics({});
  const action_set_legacy_name = action(() => {
    legacyBoard.setMyName.send({ name: " Legacy User " });
  });
  const action_add_legacy_topic = action(() => {
    legacyBoard.addTopic.send({ title: "Legacy-shaped topic" });
  });
  const action_comment_legacy_topic = action(() => {
    legacyBoard.topics?.[0]?.addComment.send({ body: "legacy comment" });
  });
  const action_link_legacy_topic = action(() => {
    legacyBoard.topics?.[0]?.addLink.send({
      kind: "web",
      url: "https://example.com/legacy",
      label: "legacy link",
    });
  });
  const action_update_legacy_topic_body = action(() => {
    legacyBoard.topics?.[0]?.setBody.send({ body: "legacy body" });
  });

  const action_comment_signed = action(() => {
    board.topics?.[0]?.addComment.send({
      body: "hello thread",
      agentName: "Sol",
    });
  });
  const action_set_body = action(() => {
    board.topics?.[0]?.setBody.send({
      body: "line one\nline two",
      agentName: "Sol",
    });
  });
  const action_link_valid_unlabeled = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/4643",
      label: "  ",
      agentName: "Sol",
    });
  });
  const action_comment_first_again = action(() => {
    board.topics?.[0]?.addComment.send({
      body: "bumping the first topic",
      agentName: "Sol",
    });
  });

  const action_submit_profile_topic = action(() => {
    profileSubmitTopic.send();
  });
  const action_submit_profile_comment = action(() => {
    profileSubmitComment.send();
  });
  const action_save_profile_body = action(() => {
    profileSaveBody.send();
  });
  const action_submit_profile_link = action(() => {
    profileSubmitLink.send();
  });
  const action_start_profile_body_edit = action(() => {
    profileTopic.startEditBody.send();
  });

  // --- UI-affordance flows (the same paths the rendered controls drive) ---

  const action_submit_blank_comment_draft = action(() => {
    directTopic.commentDraft.set("   ");
    directTopic.submitComment.send();
  });
  // Edit flows are split across test steps: startEditBody's handler runs in
  // the scheduler AFTER this action body, so a same-action draft-set would be
  // overwritten by the handler's own body→draft copy.
  const action_start_edit = action(() => {
    directTopic.startEditBody.send();
  });
  const action_cancel_edit = action(() => {
    directTopic.bodyDraft.set("abandoned draft");
    directTopic.cancelEditBody.send();
  });
  const action_submit_blank_link_draft = action(() => {
    directTopic.linkUrlDraft.set("   ");
    directTopic.submitLink.send();
  });
  // --- assertions ---

  const assert_initial = assert(() =>
    board.topicCount === 0 &&
    (board.topics ?? []).length === 0 &&
    (board.mentionable ?? []).length === 0
  );
  const assert_explicit_undefined_author_projection = assert(() =>
    mixedMentionable.get().length === 1 &&
    // The explicit undefined was accepted, then shaped through the declared
    // compatibility default for downstream readers.
    mixedMentionable.get()[0]?.createdBy?.name === "" &&
    mixedMentionable.get()[0]?.commentCount === 0 &&
    mixedMentionable.get()[0]?.lastActivityAt === 0 &&
    mixedMentionable.get()[0]?.[NAME] === "" &&
    (mixedMentionConsumer.crossrefs?.refsOut ?? []).length === 0 &&
    (mixedMentionConsumer.crossrefs?.referencedBy ?? []).length === 0
  );

  const assert_first_topic = assert(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.body === "" &&
    board.topics?.[0]?.createdBy?.kind === "agent" &&
    board.topics?.[0]?.createdBy?.name === "Sol" &&
    board.topics?.[0]?.createdByName === "Sol (agent)" &&
    (board.topics?.[0]?.createdAt ?? 0) > 0 &&
    board.topics?.[0]?.commentCount === 0 &&
    board.topics?.[0]?.lastActivityAt === board.topics?.[0]?.createdAt &&
    board.topics?.[0]?.[NAME] === "First topic"
  );

  const assert_comment_landed = assert(() =>
    board.topics?.[0]?.commentCount === 1 &&
    board.topics?.[0]?.comments?.[0]?.author?.kind === "agent" &&
    board.topics?.[0]?.comments?.[0]?.author?.name === "Sol" &&
    board.topics?.[0]?.comments?.[0]?.authorName === "Sol (agent)" &&
    board.topics?.[0]?.comments?.[0]?.body === "hello thread" &&
    (board.topics?.[0]?.comments?.[0]?.sentAt ?? 0) > 0 &&
    (board.topics?.[0]?.lastActivityAt ?? 0) >=
      (board.topics?.[0]?.createdAt ?? 0)
  );

  const assert_body_set = assert(() =>
    board.topics?.[0]?.body === "line one\nline two" &&
    board.topics?.[0]?.bodyUpdatedBy?.kind === "agent" &&
    board.topics?.[0]?.bodyUpdatedBy?.name === "Sol" &&
    (board.topics?.[0]?.bodyUpdatedAt ?? 0) > 0
  );

  // A valid https link with a blank label defaults its label to the URL.
  const assert_link_added = assert(() =>
    (board.topics?.[0]?.links ?? []).length === 1 &&
    board.topics?.[0]?.links?.[0]?.kind === "pr" &&
    board.topics?.[0]?.links?.[0]?.label ===
      "https://github.com/commontoolsinc/labs/pull/4643" &&
    board.topics?.[0]?.links?.[0]?.addedBy?.name === "Sol" &&
    (board.topics?.[0]?.links?.[0]?.addedAt ?? 0) > 0
  );

  const assert_second_topic = assert(() =>
    board.topicCount === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdBy?.kind === "agent" &&
    board.topics?.[1]?.createdBy?.name === "Fable" &&
    board[NAME] === "Topics (2)"
  );

  const assert_third_topic = assert(() =>
    board.topicCount === 3 &&
    board.topics?.[2]?.title === "Composed topic" &&
    board.topics?.[2]?.createdBy?.name === "Sol" &&
    // Body-at-create: preserved VERBATIM (whitespace-sensitive Markdown must
    // survive, matching setBody), and NOT a body update — the update stamps
    // stay unset (createdBy covers create authorship).
    board.topics?.[2]?.body === "    indented code\nline two\n" &&
    (board.topics?.[2]?.bodyUpdatedBy?.name ?? "") === "" &&
    (board.topics?.[2]?.bodyUpdatedAt ?? 0) === 0
  );

  const assert_blank_draft_rejected = assert(() =>
    directTopic.commentCount === 0
  );

  // startEditBody copied the current body into the draft and opened the editor.
  const assert_editing = assert(() =>
    directTopic.editingBody === true &&
    directTopic.bodyDraft.get() === "line one\nline two"
  );

  const assert_edit_cancelled = assert(() =>
    directTopic.editingBody === false &&
    directTopic.body === "line one\nline two"
  );

  const assert_legacy_fields_load = assert(() =>
    legacy.createdByName === "Legacy Person" &&
    legacy.createdBy?.kind === "person" &&
    legacy.createdBy?.name === "Legacy Person" &&
    legacy.comments?.[0]?.authorName === "Old Agent" &&
    legacy.comments?.[0]?.author === undefined &&
    topicAuthorLabel(legacy.createdBy, legacy.createdByName) ===
      "Legacy Person" &&
    topicAuthorLabel(
        legacy.comments?.[0]?.author,
        legacy.comments?.[0]?.authorName,
      ) === "Old Agent"
  );

  const assert_legacy_name_set = assert(() =>
    legacyBoard.myName === "Legacy User"
  );

  const assert_legacy_topic_created = assert(() =>
    legacyBoard.topicCount === 1 &&
    legacyBoard.topics?.[0]?.title === "Legacy-shaped topic" &&
    legacyBoard.topics?.[0]?.createdBy?.kind === "person" &&
    legacyBoard.topics?.[0]?.createdBy?.name === "Legacy User" &&
    legacyBoard.topics?.[0]?.createdByName === "Legacy User"
  );

  const assert_legacy_comment_landed = assert(() =>
    legacyBoard.topics?.[0]?.comments?.[0]?.author === undefined &&
    legacyBoard.topics?.[0]?.comments?.[0]?.authorName === "Legacy User" &&
    legacyBoard.topics?.[0]?.comments?.[0]?.body === "legacy comment"
  );

  const assert_legacy_link_landed = assert(() =>
    legacyBoard.topics?.[0]?.links?.[0]?.addedBy === undefined &&
    legacyBoard.topics?.[0]?.links?.[0]?.label === "legacy link"
  );

  const assert_legacy_body_landed = assert(() =>
    legacyBoard.topicCount === 1 &&
    legacyBoard.topics?.[0]?.body === "legacy body" &&
    (legacyBoard.topics?.[0]?.bodyUpdatedBy?.name ?? "") === "" &&
    (legacyBoard.topics?.[0]?.bodyUpdatedAt ?? 0) === 0
  );

  const assert_profile_topic_submitted = assert(() => {
    const list = profileTopics.get() ?? [];
    return list.length === 1 &&
      list[0]?.title === "Profile topic" &&
      list[0]?.createdBy?.kind === "person" &&
      list[0]?.createdBy?.name === "Ada" &&
      list[0]?.createdBy?.avatar === "🦊" &&
      list[0]?.createdByName === "Ada" &&
      profileTitleDraft.get() === "";
  });

  const assert_profile_comment_submitted = assert(() => {
    const list = profileComments.get() ?? [];
    return list.length === 1 &&
      list[0]?.body === "via the profile composer" &&
      list[0]?.author?.kind === "person" &&
      list[0]?.author?.name === "Ada" &&
      list[0]?.author?.avatar === "🦊" &&
      list[0]?.authorName === "Ada" &&
      (list[0]?.sentAt ?? 0) > 0 &&
      profileCommentDraft.get() === "";
  });

  const assert_profile_body_saved = assert(() =>
    profileBody.get() === "profile-edited body" &&
    profileBodyUpdatedBy.get()?.kind === "person" &&
    profileBodyUpdatedBy.get()?.name === "Ada" &&
    profileBodyUpdatedAt.get() > 0 &&
    profileEditingBody.get() === false
  );

  const assert_profile_link_submitted = assert(() => {
    const list = profileLinks.get() ?? [];
    return list.length === 1 &&
      list[0]?.kind === "session" &&
      list[0]?.url === "https://example.com/profile-link" &&
      list[0]?.label === "profile link" &&
      list[0]?.addedBy?.kind === "person" &&
      list[0]?.addedBy?.name === "Ada" &&
      list[0]?.addedBy?.avatar === "🦊" &&
      (list[0]?.addedAt ?? 0) > 0 &&
      profileLinkUrlDraft.get() === "" &&
      profileLinkLabelDraft.get() === "" &&
      profileLinkKindDraft.get() === "web";
  });

  // A fresh comment on the FIRST topic makes it the most recently active.
  const assert_pure_helpers = assert(() =>
    snippet("a b  c", 3) === "a b…" &&
    snippet("hi", 10) === "hi" &&
    whenLabel(0) === "" &&
    whenLabel(1783560681000).startsWith("Jul ") &&
    isSafeLinkUrl("https://example.com") === true &&
    isSafeLinkUrl("HTTP://EXAMPLE.COM") === true &&
    isSafeLinkUrl("javascript:alert(1)") === false &&
    isSafeLinkUrl("   ") === false &&
    topicAuthorLabel(
        { kind: "person", name: "" },
        "Legacy Person",
      ) === "Legacy Person"
  );

  // --- crossrefs: the derived prose reference graph ---

  // Fid-free corpus: rows exist (one per topic, self-describing via `topic`),
  // every fid is a real tagged hash, and no edges are claimed. Pins the
  // fid1-tag assumption the prose scan relies on — if entity ids ever stop
  // being fid1-tagged, this fails loudly instead of edges silently vanishing.
  // Runs at the two-topic point: the edge that follows must exist while the
  // harness still evaluates the board's card-list computed, so the chip
  // branches render (and count as covered), not just the data layer.
  const assert_crossrefs_baseline = assert(() =>
    (board.crossrefs ?? []).length === 2 &&
    board.crossrefs?.[0]?.fid?.startsWith("fid1:") === true &&
    (board.crossrefs?.[0]?.fid ?? "").length > 25 &&
    board.crossrefs?.[0]?.topic?.title === "First topic" &&
    board.crossrefs?.[1]?.topic?.title === "Second topic" &&
    (board.crossrefs?.[0]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 0 &&
    (board.crossrefs?.[1]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[1]?.referencedBy ?? []).length === 0
  );

  // A pasted page URL in a body creates the edge on both ends.
  const action_body_ref_first = action(() => {
    const fid = board.crossrefs?.[0]?.fid ?? "";
    board.topics?.[1]?.setBody.send({
      body: `relates to https://estuary.example/topics-dev/${fid} directly`,
      agentName: "Sol",
    });
  });
  const assert_body_edge = assert(() =>
    (board.crossrefs?.[1]?.refsOut ?? []).length === 1 &&
    board.crossrefs?.[1]?.refsOut?.[0]?.title === "First topic" &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 1 &&
    board.crossrefs?.[0]?.referencedBy?.[0]?.title === "Second topic" &&
    (board.crossrefs?.[0]?.refsOut ?? []).length === 0
  );

  // --- index: the compact discovery surface ---

  // Reference-plus-summary rows mirror the board at the two-topic point: the
  // summary scalars answer the survey questions directly, and no edges are
  // claimed before any prose references exist.
  const assert_index_baseline = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[0]?.topic?.title === "First topic" &&
    (board.index?.[0]?.createdAt ?? 0) > 0 &&
    board.index?.[0]?.createdBy?.kind === "agent" &&
    board.index?.[0]?.createdBy?.name === "Sol" &&
    board.index?.[0]?.commentCount === 1 &&
    (board.index?.[0]?.lastActivityAt ?? 0) >=
      (board.index?.[0]?.createdAt ?? 0) &&
    board.index?.[1]?.title === "Second topic" &&
    (board.index?.[0]?.refsOut ?? []).length === 0 &&
    (board.index?.[1]?.refsOut ?? []).length === 0
  );

  // The prose edge surfaces in the index as title-only sibling references.
  const assert_index_edge = assert(() =>
    (board.index?.[1]?.refsOut ?? []).length === 1 &&
    board.index?.[1]?.refsOut?.[0]?.title === "First topic" &&
    (board.index?.[0]?.referencedBy ?? []).length === 1 &&
    board.index?.[0]?.referencedBy?.[0]?.title === "Second topic"
  );

  // The bound itself: serializing the whole index carries no expanded piece
  // content (body/comments/links), no verb streams, and no runtime values —
  // the declared schema, not reader discipline, is the guarantee. Every
  // reference in a row exposes exactly the title-only projection.
  const assert_index_bounded = assert(() => {
    const rows = board.index ?? [];
    if (rows.length < 2) return false;
    const serialized = JSON.stringify(rows);
    return !serialized.includes('"body"') &&
      !serialized.includes('"comments"') &&
      !serialized.includes('"links"') &&
      !serialized.includes('"addComment"') &&
      !serialized.includes('"setBody"') &&
      !serialized.includes('"addLink"') &&
      !serialized.includes("vnode") &&
      Object.keys(rows[0]?.topic ?? {}).join(",") === "title" &&
      Object.keys(rows[1]?.refsOut?.[0] ?? {}).join(",") === "title";
  });

  // Detail-page view of the same edge: each board-created topic derives its
  // own row from the mentionable siblings wired at creation (piece-valued,
  // resolved from `mentionable` = the board's own list), while a piece with no
  // mentionable derives empty sets.
  const assert_detail_edges = assert(() => {
    return board.topics?.[1]?.crossrefs?.refsOut?.[0]?.title ===
        "First topic" &&
      (board.topics?.[1]?.crossrefs?.refsOut ?? []).length === 1 &&
      (board.topics?.[1]?.crossrefs?.referencedBy ?? []).length === 0 &&
      board.topics?.[0]?.crossrefs?.referencedBy?.[0]?.title ===
        "Second topic" &&
      (board.topics?.[0]?.crossrefs?.referencedBy ?? []).length === 1 &&
      (board.topics?.[0]?.crossrefs?.refsOut ?? []).length === 0;
  });

  const assert_lone_edgeless = assert(() => {
    return (lone.crossrefs?.refsOut ?? []).length === 0 &&
      (lone.crossrefs?.referencedBy ?? []).length === 0;
  });

  // Pin the persisted navigation contract directly. A cold renderer must see
  // ordinary cf-cell-link destinations, never pattern-owned handler streams.
  const assert_cell_link_markup = assert(() => {
    const rows = board.crossrefs ?? [];
    if (rows.length < 2 || !rows[0]?.fid || !rows[1]?.fid) return false;
    const row = crossrefLinkRow("references →", [
      { fid: rows[0].fid, title: rows[0].topic.title },
      { fid: rows[1].fid, title: rows[1].topic.title },
    ]);
    const open = topicCellLink(rows[0].fid, "Open");
    const rowLinks = findAllByTag(row, "cf-cell-link");
    const openLinks = findAllByTag(open, "cf-cell-link");
    return row !== null &&
      open !== null &&
      rowLinks.length === 2 &&
      openLinks.length === 1 &&
      propValue(rowLinks[0].props.link) === `/of:${rows[0].fid}` &&
      propValue(rowLinks[1].props.link) === `/of:${rows[1].fid}` &&
      propValue(openLinks[0].props.link) === `/of:${rows[0].fid}` &&
      propValue(openLinks[0].props.label) === "Open" &&
      propValue(openLinks[0].props.static) === true &&
      openLinks[0].props.onClick === undefined &&
      openLinks[0].props["oncf-click"] === undefined &&
      crossrefLinkRow("← referenced by", []) === null &&
      topicCellLink("", "Open") === null;
  });

  // A share link in a comment counts too — its colon is percent-encoded.
  const action_comment_ref_encoded = action(() => {
    const enc = (board.crossrefs?.[0]?.fid ?? "").replace(":", "%3A");
    board.topics?.[2]?.addComment.send({
      body: `shared as ?shared-pattern=estuary%2Ftopics-dev%2F${enc}`,
      agentName: "Sol",
    });
  });
  const assert_comment_edge = assert(() =>
    (board.crossrefs?.[2]?.refsOut ?? []).length === 1 &&
    board.crossrefs?.[2]?.refsOut?.[0]?.title === "First topic" &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 2
  );

  // A structured link's URL is part of the corpus (scan ∪ TopicLink).
  const action_link_ref_second = action(() => {
    board.topics?.[2]?.addLink.send({
      kind: "topic",
      url: `https://estuary.example/topics-dev/${
        board.crossrefs?.[1]?.fid ?? ""
      }`,
      label: "the second topic",
      agentName: "Sol",
    });
  });
  const assert_link_edge = assert(() =>
    (board.crossrefs?.[2]?.refsOut ?? []).length === 2 &&
    board.crossrefs?.[2]?.refsOut?.[1]?.title === "Second topic" &&
    (board.crossrefs?.[1]?.referencedBy ?? []).length === 1 &&
    board.crossrefs?.[1]?.referencedBy?.[0]?.title === "Composed topic"
  );

  // Mentioning yourself or a fid nothing on the board owns adds no edges.
  const action_self_and_unknown_ref = action(() => {
    const own = board.crossrefs?.[0]?.fid ?? "";
    board.topics?.[0]?.setBody.send({
      body: `self ${own} and unknown fid1:${"Z".repeat(43)} stay edgeless`,
      agentName: "Sol",
    });
  });
  const assert_self_unknown_ignored = assert(() =>
    (board.crossrefs?.[0]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 2 &&
    // The topic's own Connections card derives its outbound edges from its
    // prose, not from the board's join, so the two can disagree about a
    // self-mention. Assert the topic-side view drops it as well.
    (board.topics?.[0]?.crossrefs?.refsOut ?? []).length === 0
  );

  // Nothing is persisted: retract the prose and the edge is simply gone.
  const action_remove_body_ref = action(() => {
    board.topics?.[1]?.setBody.send({
      body: "no references anymore",
      agentName: "Sol",
    });
  });
  const assert_edge_removed = assert(() =>
    (board.crossrefs?.[1]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 1 &&
    board.crossrefs?.[0]?.referencedBy?.[0]?.title === "Composed topic"
  );

  // The fid-scanning helpers, over every pasted shape (bare, of:-prefixed,
  // percent-encoded) plus the non-matches (short payloads, non-fid hashes).
  const P1 = "A".repeat(43);
  const P2 = "B".repeat(43);
  const assert_crossref_helpers = assert(() =>
    extractFidPayloads(
        `a fid1:${P1} b of:fid1:${P2} c fid1%3A${P1}`,
      ).join(",") === `${P1},${P2},${P1}` &&
    extractFidPayloads("no fids here, not even fid1:tooshort").length === 0 &&
    extractFidPayloads("").length === 0 &&
    fidPayload(`fid1:${P1}`) === P1 &&
    fidPayload(` fid1:${P1} `) === P1 &&
    fidPayload("of:fid1:" + P1) === "" &&
    fidPayload("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy") === "" &&
    fidPayload("") === ""
  );

  // The shared join (the piece notes imports when backlinks-index's write
  // path retires): one payload→entry map, one scan per corpus. First-mention
  // order out, ascending referrers in; repeats, self-mentions, and payloads
  // no entry owns all drop.
  const assert_crossref_join = assert(() => {
    const P3 = "C".repeat(43);
    const joined = crossrefJoin(
      [
        `self fid1:${P1} then fid1:${P2}`,
        "",
        `fid1:${P2} twice fid1:${P2} then fid1:${P1} unknown fid1:${
          "Z".repeat(43)
        }`,
      ],
      [P1, P2, P3],
    );
    return joined.refsOut[0].join(",") === "1" &&
      joined.refsOut[1].join(",") === "" &&
      joined.refsOut[2].join(",") === "1,0" &&
      joined.referencedBy[0].join(",") === "2" &&
      joined.referencedBy[1].join(",") === "0,2" &&
      joined.referencedBy[2].join(",") === "" &&
      topicCorpus({
          body: "b",
          comments: [{ body: "c" }],
          links: [{ url: "u" }],
        }) === "b\nc\nu" &&
      topicCorpus(undefined) === "";
  });

  return {
    // UI demand (#4715) over the board: its card list — including the in-card
    // crossref chip rows — renders through the real reconciler while the suite
    // runs. The cards bind navigation to crossref-row pieces (wrapper-nested),
    // which need real reconcile cycles to settle, so the passive [UI] export is
    // backed by explicit `{ render: board[UI] }` steps below. Those cover the
    // card path in both coverage lanes AND guard the wrapper-bind mechanism: a
    // silent non-render regression (blank board, no error) would leave those
    // lines uncovered and trip the coverage gate. A board list element is the
    // shared-safe TopicPiece projection and exposes no [UI]; the topic detail
    // page is driven through its own render step.
    [UI]: board[UI],
    [TESTS]: [
      { assertion: assert_initial },
      { action: action_link_unsigned_mixed_version_sibling },
      { assertion: assert_explicit_undefined_author_projection },
      { action: action_submit_profile_topic },
      { assertion: assert_profile_topic_submitted },
      { action: action_submit_profile_comment },
      { assertion: assert_profile_comment_submitted },
      { action: action_save_profile_body },
      { assertion: assert_profile_body_saved },
      { action: action_submit_profile_link },
      { assertion: assert_profile_link_submitted },
      { action: action_set_legacy_name },
      { assertion: assert_legacy_name_set },
      { action: action_add_legacy_topic },
      { assertion: assert_legacy_topic_created },
      { action: action_comment_legacy_topic },
      { assertion: assert_legacy_comment_landed },
      { action: action_link_legacy_topic },
      { assertion: assert_legacy_link_landed },
      { action: action_update_legacy_topic_body },
      { assertion: assert_legacy_body_landed },
      // Render the Profile-authored rows after their mutations land, then the
      // edit state whose Save control is disabled until #profile resolves.
      { render: profileTopic[UI] },
      { action: action_start_profile_body_edit },
      { render: profileTopic[UI] },
      { action: action_add_first_topic },
      { assertion: assert_first_topic },
      { action: action_comment_signed },
      { assertion: assert_comment_landed },
      { action: action_set_body },
      { assertion: assert_body_set },
      { action: action_link_valid_unlabeled },
      { assertion: assert_link_added },
      { action: action_add_second_topic },
      { assertion: assert_second_topic },
      { render: board[UI] },
      { assertion: assert_crossrefs_baseline },
      { assertion: assert_index_baseline },
      { action: action_body_ref_first },
      { assertion: assert_body_edge },
      { assertion: assert_index_edge },
      { assertion: assert_index_bounded },
      { render: board[UI] },
      { assertion: assert_detail_edges },
      { assertion: assert_lone_edgeless },
      { assertion: assert_cell_link_markup },
      { render: board[UI] },
      { action: action_comment_first_again },
      { action: action_add_third_topic },
      { assertion: assert_third_topic },
      { action: action_submit_blank_comment_draft },
      { assertion: assert_blank_draft_rejected },
      { action: action_start_edit },
      { assertion: assert_editing },
      { action: action_cancel_edit },
      { assertion: assert_edit_cancelled },
      { action: action_submit_blank_link_draft },
      // Materialize the direct and legacy Topics without putting UI into the
      // board's shared TopicPiece projection.
      { render: directTopic[UI] },
      { render: legacy[UI] },
      { assertion: assert_legacy_fields_load },
      { assertion: assert_pure_helpers },
      { action: action_comment_ref_encoded },
      { assertion: assert_comment_edge },
      { action: action_link_ref_second },
      { assertion: assert_link_edge },
      { action: action_self_and_unknown_ref },
      { assertion: assert_self_unknown_ignored },
      { action: action_remove_body_ref },
      { assertion: assert_edge_removed },
      { assertion: assert_crossref_helpers },
      { assertion: assert_crossref_join },
    ],
  };
});
