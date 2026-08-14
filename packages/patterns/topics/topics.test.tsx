/**
 * Single-runtime pattern tests for Topics (CT-1878).
 *
 * Complements multi-user.test.tsx (cross-runtime isolation and merge
 * behavior) and topics-rejections.test.tsx (thrown rejections on the mutating
 * verbs — those runs expect runtime errors): this file drives the happy and
 * legacy paths in one runtime — atomic agent signatures, body-at-create,
 * legacy authorship fallback/shadow fields, label defaulting, body updates,
 * activity-based sorting, the board's bounded discovery index, and the exported
 * pure helpers. UI composer wrappers keep silent guards, exercised here.
 */
import {
  action,
  assert,
  Default,
  NAME,
  Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { pattern } from "commonfabric";
import Topics, {
  submitProfileTopic,
  topicCellLink,
  type TopicCrossrefRow,
  type TopicPiece,
} from "./main.tsx";
import Topic, {
  type AddCommentResult,
  type AddLinkResult,
  fidPayload,
  isSafeLinkUrl,
  type MentionEvent,
  mentionKeyFor,
  type MentionResult,
  saveProfileBody,
  type SetBodyResult,
  snippet,
  submitProfileComment,
  submitProfileLink,
  type TopicAuthor,
  topicAuthorLabel,
  type TopicComment,
  type TopicLink,
  type TopicLinkKind,
  type TopicMentionRefMap,
  type TopicSummary,
  type UnmentionEvent,
  type UnmentionResult,
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
/**
 * What a topic pattern deployed before the current paths existed publishes.
 *
 * Declared explicitly rather than inferred, because the shim returns undefined
 * for the paths it predates and an inferred `unknown` there would make the
 * output schema carry `{ type: "unknown" }` — which a consumer reads back as
 * undefined for reasons that have nothing to do with this test. Spelling the
 * shape out says the real thing: these paths are absent from a legacy sibling,
 * and `TopicPiece` — where they now carry a default and no `| undefined` — has
 * to survive being handed one.
 */
interface LegacyUnsignedTopicOutput {
  [NAME]: string | undefined;
  title: string;
  body: string;
  comments: TopicComment[];
  links: TopicLink[];
  createdAt: number;
  createdBy: TopicAuthor | undefined;
  createdByName: string;
  mentions: unknown[] | undefined;
  references: TopicMentionRefMap | undefined;
  referencedBy: TopicSummary[] | undefined;
  commentCount: number | undefined;
  lastActivityAt: number | undefined;
  addComment: Stream<{ body: string }, AddCommentResult>;
  addLink: Stream<
    { kind: TopicLinkKind; url: string; label: string },
    AddLinkResult
  >;
  setBody: Stream<{ body: string }, SetBodyResult>;
  mention: Stream<MentionEvent, MentionResult>;
  unmention: Stream<UnmentionEvent, UnmentionResult>;
}

const LegacyUnsignedTopic = pattern<
  Record<PropertyKey, never>,
  LegacyUnsignedTopicOutput
>(() => {
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
  const mention = action<MentionEvent, MentionResult>(() => ({ key: "" }));
  const unmention = action<UnmentionEvent, UnmentionResult>(() => ({
    keys: [],
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
    // Absent for the same reason `createdBy` is: this sibling predates these
    // paths, and the current projection has to accept that.
    //
    // These two now declare a default and no `| undefined` on `TopicPiece`,
    // which is exactly what this sibling is here to exercise: a retained
    // mixed-version link materializes a missing path as a present undefined,
    // and current list validation has to survive it.
    mentions: undefined,
    references: undefined,
    referencedBy: undefined,
    commentCount: undefined,
    lastActivityAt: undefined,
    addComment,
    addLink,
    setBody,
    mention,
    unmention,
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
  // mentionable universe: the consumer must validate it without weakening
  // non-empty authorship away from TopicAuthor.
  const mixedMentionable = new Writable<
    TopicPiece[] | Default<[]>
  >([]);
  const mixedMentionConsumer = Topic({
    title: "Mixed mention consumer",
    mentionable: mixedMentionable,
  });

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
  // Standalone: no board built this, so there is no pivot to read and the topic
  // it creates simply shows no inbound references. Required rather than
  // optional so a real composer cannot forget it and silently lose them.
  const profileBoardCrossrefs = new Writable<TopicCrossrefRow[] | Default<[]>>(
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
      LegacyUnsignedTopic({}) as TopicPiece,
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
    // The consumer holding that list materialized rather than failing argument
    // validation on the mixed-version link.
    mixedMentionConsumer[NAME] === "Mixed mention consumer"
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

  // --- index: the board's bounded discovery surface ---

  // Address-plus-summary rows mirror the board at the two-topic point: every
  // fid is a real tagged hash, and the summary scalars answer the survey
  // questions directly. Pins the fid1-tag assumption addressing relies on — if
  // entity ids ever stop being fid1-tagged, this fails loudly instead of every
  // row's address silently going blank.
  //
  // Runs while the harness still evaluates the board's card-list computed, so
  // the card branches render (and count as covered), not just the data layer.
  const assert_index_baseline = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.fid?.startsWith("fid1:") === true &&
    (board.index?.[0]?.fid ?? "").length > 25 &&
    board.index?.[1]?.fid !== board.index?.[0]?.fid &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[0]?.topic?.title === "First topic" &&
    (board.index?.[0]?.createdAt ?? 0) > 0 &&
    board.index?.[0]?.createdBy?.kind === "agent" &&
    board.index?.[0]?.createdBy?.name === "Sol" &&
    board.index?.[0]?.commentCount === 1 &&
    (board.index?.[0]?.lastActivityAt ?? 0) >=
      (board.index?.[0]?.createdAt ?? 0) &&
    board.index?.[1]?.title === "Second topic" &&
    board.index?.[1]?.topic?.title === "Second topic"
  );

  // The bound itself: serializing the whole index carries no expanded piece
  // content (body/comments/links), no verb streams, and no runtime values —
  // the declared schema, not reader discipline, is the guarantee. Each row's
  // reference exposes exactly the title-only projection.
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
      Object.keys(rows[1]?.topic ?? {}).join(",") === "title";
  });

  // The index tracks the board rather than snapshotting it: a topic added
  // later gets its own row, with its own address and its own scalars.
  const assert_index_tracks_the_board = assert(() =>
    (board.index ?? []).length === 3 &&
    board.index?.[2]?.title === "Composed topic" &&
    board.index?.[2]?.fid?.startsWith("fid1:") === true &&
    board.index?.[2]?.fid !== board.index?.[0]?.fid &&
    board.index?.[2]?.createdBy?.name === "Sol" &&
    // The first topic took a second comment before this one was created, and
    // its row carries the updated count rather than the one it was built with.
    board.index?.[0]?.commentCount === 2
  );

  // Pin the persisted navigation contract directly. A cold renderer must see
  // ordinary cf-cell-link destinations, never pattern-owned handler streams.
  const assert_cell_link_markup = assert(() => {
    const fid = board.index?.[0]?.fid ?? "";
    if (!fid) return false;
    const open = topicCellLink(fid, "Open");
    const openLinks = findAllByTag(open, "cf-cell-link");
    return open !== null &&
      openLinks.length === 1 &&
      propValue(openLinks[0].props.link) === `/of:${fid}` &&
      propValue(openLinks[0].props.label) === "Open" &&
      propValue(openLinks[0].props.static) === true &&
      openLinks[0].props.onClick === undefined &&
      openLinks[0].props["oncf-click"] === undefined &&
      // No fid yet (a topic mid-sync) renders nothing rather than a link to
      // nowhere.
      topicCellLink("", "Open") === null;
  });

  // The fid helper that turns a resolved entity id into a row's address, over
  // the tagged form it accepts and the shapes it must reject (storage form,
  // short payloads, a non-fid hash).
  const P1 = "A".repeat(43);
  // --- cross-references: the board's mention pivot ---

  // Driven entirely through the real board, so the wiring under test is the
  // wiring `addTopic` gives its own children.
  const graphBoard = Topics({});
  const action_add_graph_topics = action(() => {
    graphBoard.addTopic.send({ title: "Graph target", agentName: "Sol" });
    graphBoard.addTopic.send({ title: "Graph source", agentName: "Sol" });
    graphBoard.addTopic.send({ title: "Graph third", agentName: "Sol" });
  });

  // No mentions yet: a row exists per topic and claims no edges.
  const assert_graph_baseline = assert(() =>
    (graphBoard.crossrefs ?? []).length === 3 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 0 &&
    (graphBoard.topics?.[0]?.mentions ?? []).length === 0
  );

  // Making a mention passes the PIECE, not an address. Nothing parses text and
  // no id is minted: the reference is the identity.
  const action_source_mentions_target = action(() => {
    graphBoard.topics?.[1]?.mention?.send({ topic: graphBoard.topics?.[0] });
  });
  const assert_reference_edge = assert(() =>
    (graphBoard.topics?.[1]?.mentions ?? []).length === 1 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 1 &&
    graphBoard.topics?.[0]?.referencedBy?.[0]?.title === "Graph source" &&
    // Mentioning is not symmetric.
    (graphBoard.topics?.[1]?.referencedBy ?? []).length === 0
  );

  // A topic that mentions ITSELF records the mention but earns no inbound edge:
  // referencing yourself is not being referenced from somewhere else.
  const action_target_mentions_itself = action(() => {
    graphBoard.topics?.[0]?.mention?.send({ topic: graphBoard.topics?.[0] });
  });
  const assert_self_reference_ignored = assert(() =>
    (graphBoard.topics?.[0]?.mentions ?? []).length === 1 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 1
  );

  // Nothing was written into the target: retract the mention and the edge is
  // simply gone from the topic that was being referenced.
  const action_source_retracts_mention = action(() => {
    graphBoard.topics?.[1]?.unmention?.send({ topic: graphBoard.topics?.[0] });
  });
  const assert_reference_retracted = assert(() =>
    (graphBoard.topics?.[1]?.mentions ?? []).length === 0 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 0
  );

  // A piece with no board wired in shows no inbound references rather than
  // failing: `boardCrossrefs` is optional, as `mentionable` is.
  const assert_boardless_topic_has_no_backlinks = assert(() =>
    (directTopic.referencedBy ?? []).length === 0
  );

  // The key a destination gets, derived from the destination rather than
  // allocated: the same piece always yields the same key — so two writers
  // referencing it merge instead of clobbering — and the result stays inside
  // the `[0-9a-z]{6,10}` shape the editor parses.
  const P = "A".repeat(43);
  const assert_mention_keys = assert(() =>
    mentionKeyFor(P) === "aaaaaaaa" &&
    mentionKeyFor(P) === mentionKeyFor(P) &&
    mentionKeyFor("B".repeat(43)) !== mentionKeyFor(P) &&
    // base64url carries two characters base36 does not; they drop out rather
    // than producing a key the editor's parser would refuse.
    /^[0-9a-z]{8}$/.test(mentionKeyFor("-_aB3-_9zQ_-xY")) &&
    mentionKeyFor("") === ""
  );

  // The case that makes per-key writes matter: two mentions, one retracted.
  // Rebuilding the map from a read would carry the survivor through a resolve
  // and flatten its destination, silently retracting it too.
  const action_source_mentions_both = action(() => {
    graphBoard.topics?.[1]?.mention?.send({ topic: graphBoard.topics?.[0] });
    graphBoard.topics?.[1]?.mention?.send({ topic: graphBoard.topics?.[2] });
  });
  const assert_two_mentions = assert(() =>
    (graphBoard.topics?.[1]?.mentions ?? []).length === 2 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 1 &&
    (graphBoard.topics?.[2]?.referencedBy ?? []).length === 1
  );
  const action_retract_one_of_two = action(() => {
    graphBoard.topics?.[1]?.unmention?.send({ topic: graphBoard.topics?.[0] });
  });
  const assert_survivor_still_an_edge = assert(() =>
    (graphBoard.topics?.[1]?.mentions ?? []).length === 1 &&
    (graphBoard.topics?.[0]?.referencedBy ?? []).length === 0 &&
    // The one that was NOT retracted is still a reference, not a flattened
    // copy of the piece it names.
    (graphBoard.topics?.[2]?.referencedBy ?? []).length === 1
  );

  const assert_fid_payload = assert(() =>
    fidPayload(`fid1:${P1}`) === P1 &&
    fidPayload(` fid1:${P1} `) === P1 &&
    fidPayload("of:fid1:" + P1) === "" &&
    fidPayload("fid1:tooshort") === "" &&
    fidPayload("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy") === "" &&
    fidPayload("") === ""
  );

  return {
    // UI demand (#4715) over the board: its card list renders through the real
    // reconciler while the suite runs. The cards bind navigation to index-row
    // pieces (wrapper-nested), which need real reconcile cycles to settle, so
    // the passive [UI] export is backed by explicit `{ render: board[UI] }`
    // steps below. Those cover the card path in both coverage lanes AND guard
    // the wrapper-bind mechanism: a silent non-render regression (blank board,
    // no error) would leave those lines uncovered and trip the coverage gate. A
    // board list element is the shared-safe TopicPiece projection and exposes no
    // [UI]; the topic detail page is driven through its own render step.
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
      { assertion: assert_index_baseline },
      { assertion: assert_index_bounded },
      { assertion: assert_cell_link_markup },
      { render: board[UI] },
      { action: action_comment_first_again },
      { action: action_add_third_topic },
      { assertion: assert_third_topic },
      { render: board[UI] },
      { assertion: assert_index_tracks_the_board },
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
      { assertion: assert_fid_payload },
      { action: action_add_graph_topics },
      { assertion: assert_graph_baseline },
      { action: action_source_mentions_target },
      { assertion: assert_reference_edge },
      { action: action_target_mentions_itself },
      { assertion: assert_self_reference_ignored },
      { action: action_source_retracts_mention },
      { assertion: assert_reference_retracted },
      { assertion: assert_boardless_topic_has_no_backlinks },
      { assertion: assert_mention_keys },
      { action: action_source_mentions_both },
      { assertion: assert_two_mentions },
      { action: action_retract_one_of_two },
      { assertion: assert_survivor_still_an_edge },
    ],
  };
});
