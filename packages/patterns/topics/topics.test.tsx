/**
 * Single-runtime pattern tests for Topics (CT-1878).
 *
 * Complements multi-user.test.tsx (which covers cross-runtime isolation and
 * merge behavior): this file drives every exposed stream and derived value in
 * one runtime — action guards, authorship fallback ("someone" before a name
 * is set), the unsafe-scheme link rejection, label defaulting, body Edit→Save
 * via setBody, activity-based sorting, the derived crossref graph (edges from
 * fids pasted in bodies, comments, and link URLs; never persisted), and the
 * exported pure helpers.
 */
import { action, computed, NAME, UI } from "commonfabric";
import { pattern } from "commonfabric";
import Topics, {
  crossrefChipRow,
  openTopic,
  type TopicPiece,
} from "./main.tsx";
import Topic, {
  extractFidPayloads,
  fidPayload,
  isSafeLinkUrl,
  snippet,
  whenLabel,
} from "./topic.tsx";

export default pattern(() => {
  const board = Topics({});
  // The board stores only TopicPiece's shared-safe projection. Exercise the
  // session-local UI controls on a direct Topic instance so this test does not
  // require those narrower cells to resolve through the shared topics array.
  const directTopic = Topic({
    title: "Direct topic",
    body: "line one\nline two",
  });

  // --- actions ---

  const action_add_blank_topic = action(() => {
    board.addTopic.send({ title: "   " });
  });
  const action_add_first_topic = action(() => {
    board.addTopic.send({ title: "  First topic  " });
  });
  const action_set_name = action(() => {
    board.setMyName.send({ name: "  Tester  " });
  });
  const action_add_second_topic = action(() => {
    board.addTopic.send({ title: "Second topic" });
  });

  const action_blank_comment = action(() => {
    board.topics?.[0]?.addComment.send({ body: "   " });
  });
  const action_comment_unnamed = action(() => {
    board.topics?.[0]?.addComment.send({ body: "hello thread" });
  });
  const action_set_body = action(() => {
    board.topics?.[0]?.setBody.send({ body: "line one\nline two" });
  });
  const action_link_unsafe = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "web",
      url: "javascript:alert(1)",
      label: "evil",
    });
  });
  const action_link_blank = action(() => {
    board.topics?.[0]?.addLink.send({ kind: "web", url: "   ", label: "x" });
  });
  const action_link_valid_unlabeled = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "pr",
      url: "https://github.com/commontoolsinc/labs/pull/4643",
      label: "  ",
    });
  });
  const action_comment_first_again = action(() => {
    board.topics?.[0]?.addComment.send({ body: "bumping the first topic" });
  });

  // --- UI-affordance flows (the same paths the rendered controls drive) ---

  const action_submit_topic_via_composer = action(() => {
    board.newTitle?.set("Composed topic");
    board.submitTopic.send();
  });
  const action_submit_blank_comment_draft = action(() => {
    directTopic.commentDraft.set("   ");
    directTopic.submitComment.send();
  });
  const action_submit_comment_draft = action(() => {
    directTopic.commentDraft.set("via the composer");
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
  const action_save_edit = action(() => {
    directTopic.bodyDraft.set("edited body");
    directTopic.saveBody.send();
  });
  const action_submit_blank_link_draft = action(() => {
    directTopic.linkUrlDraft.set("   ");
    directTopic.submitLink.send();
  });
  const action_submit_link_draft = action(() => {
    directTopic.linkUrlDraft.set("https://example.com/design");
    directTopic.linkLabelDraft.set("design notes");
    directTopic.linkKindDraft.set("session");
    directTopic.submitLink.send();
  });
  // Bound at pattern-body level (binding inside an action is an illegal
  // position); the reactive reference resolves at send time, by which point
  // the first topic exists.
  const boundOpenFirst = openTopic({
    topic: board.topics[0] as TopicPiece,
  });
  const action_open_topic = action(() => {
    boundOpenFirst.send();
  });

  // --- assertions ---

  const assert_initial = computed(() =>
    board.topicCount === 0 &&
    board.myName === "" &&
    (board.topics ?? []).length === 0 &&
    (board.mentionable ?? []).length === 0
  );

  // Blank titles are rejected by the addTopic guard.
  const assert_still_empty = computed(() => board.topicCount === 0);

  // Topic created before any name is set: authorship falls back to "someone"
  // (the `(myName.get() ?? "").trim()` guard — cubic P1 on PR #4643).
  const assert_first_topic = computed(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdByName === "someone" &&
    (board.topics?.[0]?.createdAt ?? 0) > 0 &&
    board.topics?.[0]?.commentCount === 0 &&
    board.topics?.[0]?.lastActivityAt === board.topics?.[0]?.createdAt &&
    board.topics?.[0]?.[NAME] === "First topic"
  );

  const assert_named = computed(() => board.myName === "Tester");

  const assert_blank_comment_rejected = computed(() =>
    board.topics?.[0]?.commentCount === 0
  );

  const assert_comment_landed = computed(() =>
    board.topics?.[0]?.commentCount === 1 &&
    board.topics?.[0]?.comments?.[0]?.authorName === "Tester" &&
    board.topics?.[0]?.comments?.[0]?.body === "hello thread" &&
    (board.topics?.[0]?.comments?.[0]?.sentAt ?? 0) > 0 &&
    (board.topics?.[0]?.lastActivityAt ?? 0) >=
      (board.topics?.[0]?.createdAt ?? 0)
  );

  const assert_body_set = computed(() =>
    board.topics?.[0]?.body === "line one\nline two"
  );

  // javascript: and blank URLs are rejected; a valid https link with a blank
  // label defaults its label to the URL.
  const assert_links_guarded = computed(() =>
    (board.topics?.[0]?.links ?? []).length === 0
  );
  const assert_link_added = computed(() =>
    (board.topics?.[0]?.links ?? []).length === 1 &&
    board.topics?.[0]?.links?.[0]?.kind === "pr" &&
    board.topics?.[0]?.links?.[0]?.label ===
      "https://github.com/commontoolsinc/labs/pull/4643"
  );

  // Second topic created after naming: authorship snapshots the name; the
  // board name computed reflects the count.
  const assert_second_topic = computed(() =>
    board.topicCount === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdByName === "Tester" &&
    board[NAME] === "Topics (2)"
  );

  const assert_composed_topic = computed(() =>
    board.topicCount === 3 &&
    board.topics?.[2]?.title === "Composed topic" &&
    board.newTitle?.get() === ""
  );

  const assert_blank_draft_rejected = computed(() =>
    directTopic.commentCount === 0
  );

  const assert_composer_comment = computed(() =>
    directTopic.commentCount === 1 &&
    directTopic.comments?.[0]?.body === "via the composer" &&
    directTopic.commentDraft.get() === ""
  );

  // startEditBody copied the current body into the draft and opened the editor.
  const assert_editing = computed(() =>
    directTopic.editingBody === true &&
    directTopic.bodyDraft.get() === "line one\nline two"
  );

  const assert_edit_cancelled = computed(() =>
    directTopic.editingBody === false &&
    directTopic.body === "line one\nline two"
  );

  const assert_edit_saved = computed(() =>
    directTopic.editingBody === false &&
    directTopic.body === "edited body"
  );

  const assert_link_draft_flow = computed(() =>
    (directTopic.links ?? []).length === 1 &&
    directTopic.links?.[0]?.kind === "session" &&
    directTopic.links?.[0]?.label === "design notes" &&
    directTopic.linkUrlDraft.get() === "" &&
    directTopic.linkKindDraft.get() === "web"
  );

  // A fresh comment on the FIRST topic makes it the most recently active.
  const assert_pure_helpers = computed(() =>
    snippet("a b  c", 3) === "a b…" &&
    snippet("hi", 10) === "hi" &&
    whenLabel(0) === "" &&
    whenLabel(1783560681000).startsWith("Jul ") &&
    isSafeLinkUrl("https://example.com") === true &&
    isSafeLinkUrl("HTTP://EXAMPLE.COM") === true &&
    isSafeLinkUrl("javascript:alert(1)") === false &&
    isSafeLinkUrl("   ") === false
  );

  // --- crossrefs: the derived prose reference graph ---

  // Fid-free corpus: rows exist (one per topic, self-describing via `topic`),
  // every fid is a real tagged hash, and no edges are claimed. Pins the
  // fid1-tag assumption the prose scan relies on — if entity ids ever stop
  // being fid1-tagged, this fails loudly instead of edges silently vanishing.
  // Runs at the two-topic point: the edge that follows must exist while the
  // harness still evaluates the board's card-list computed, so the chip
  // branches render (and count as covered), not just the data layer.
  const assert_crossrefs_baseline = computed(() =>
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
    });
  });
  const assert_body_edge = computed(() =>
    (board.crossrefs?.[1]?.refsOut ?? []).length === 1 &&
    board.crossrefs?.[1]?.refsOut?.[0]?.title === "First topic" &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 1 &&
    board.crossrefs?.[0]?.referencedBy?.[0]?.title === "Second topic" &&
    (board.crossrefs?.[0]?.refsOut ?? []).length === 0
  );

  // Drives the exact chip markup the card map emits, independent of UI
  // demand timing: a populated row yields the hstack vnode — navigation
  // binds included — and an edgeless row collapses to null so the card
  // renders nothing for it. The real in-card path renders too: this suite
  // exports [UI], so the harness demands the vdom continuously (#4715).
  const assert_chip_row_markup = computed(() => {
    const list = (board.topics ?? []) as TopicPiece[];
    if (list.length < 2) return false;
    const row = crossrefChipRow("references →", false, list, [0, 1]);
    return row !== null &&
      crossrefChipRow("← referenced by", true, list, []) === null;
  });

  // A share link in a comment counts too — its colon is percent-encoded.
  const action_comment_ref_encoded = action(() => {
    const enc = (board.crossrefs?.[0]?.fid ?? "").replace(":", "%3A");
    board.topics?.[2]?.addComment.send({
      body: `shared as ?shared-pattern=estuary%2Ftopics-dev%2F${enc}`,
    });
  });
  const assert_comment_edge = computed(() =>
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
    });
  });
  const assert_link_edge = computed(() =>
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
    });
  });
  const assert_self_unknown_ignored = computed(() =>
    (board.crossrefs?.[0]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 2
  );

  // Nothing is persisted: retract the prose and the edge is simply gone.
  const action_remove_body_ref = action(() => {
    board.topics?.[1]?.setBody.send({ body: "no references anymore" });
  });
  const assert_edge_removed = computed(() =>
    (board.crossrefs?.[1]?.refsOut ?? []).length === 0 &&
    (board.crossrefs?.[0]?.referencedBy ?? []).length === 1 &&
    board.crossrefs?.[0]?.referencedBy?.[0]?.title === "Composed topic"
  );

  // The fid-scanning helpers, over every pasted shape (bare, of:-prefixed,
  // percent-encoded) plus the non-matches (short payloads, non-fid hashes).
  const P1 = "A".repeat(43);
  const P2 = "B".repeat(43);
  const assert_crossref_helpers = computed(() =>
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

  return {
    [UI]: board[UI],
    tests: [
      { assertion: assert_initial },
      { action: action_add_blank_topic },
      { assertion: assert_still_empty },
      { action: action_add_first_topic },
      { assertion: assert_first_topic },
      { action: action_set_name },
      { assertion: assert_named },
      { action: action_blank_comment },
      { assertion: assert_blank_comment_rejected },
      { action: action_comment_unnamed },
      { assertion: assert_comment_landed },
      { action: action_set_body },
      { assertion: assert_body_set },
      { action: action_link_unsafe },
      { assertion: assert_links_guarded },
      { action: action_link_blank },
      { assertion: assert_links_guarded },
      { action: action_link_valid_unlabeled },
      { assertion: assert_link_added },
      { action: action_add_second_topic },
      { assertion: assert_second_topic },
      { assertion: assert_crossrefs_baseline },
      { action: action_body_ref_first },
      { assertion: assert_body_edge },
      { assertion: assert_chip_row_markup },
      { action: action_comment_first_again },
      { action: action_submit_topic_via_composer },
      { assertion: assert_composed_topic },
      { action: action_submit_blank_comment_draft },
      { assertion: assert_blank_draft_rejected },
      { action: action_submit_comment_draft },
      { assertion: assert_composer_comment },
      { action: action_start_edit },
      { assertion: assert_editing },
      { action: action_cancel_edit },
      { assertion: assert_edit_cancelled },
      { action: action_start_edit },
      { action: action_save_edit },
      { assertion: assert_edit_saved },
      { action: action_submit_blank_link_draft },
      { action: action_submit_link_draft },
      // Materialize the direct Topic after its comment and link exist so the
      // nested row renderers are exercised without putting UI into TopicPiece.
      { render: directTopic[UI] },
      { assertion: assert_link_draft_flow },
      { action: action_open_topic },
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
    ],
  };
});
