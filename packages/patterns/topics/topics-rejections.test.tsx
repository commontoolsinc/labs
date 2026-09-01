/**
 * Rejection-path tests for the Topics mutating verbs (verb contract rule 4,
 * docs/plans/pattern-verb-contract.md: rejection is a value, never a silent
 * no-op). Every action here makes a verb throw, so the runtime errors are
 * required (`expectRuntimeErrors: 33` — exact count, so a rejection quietly
 * reverting to a silent return fails the suite); each assertion then verifies
 * the write did NOT land. Happy and legacy paths live in topics.test.tsx — including the UI
 * composer wrappers, whose silent guards are correct behavior (an empty draft
 * is a non-event in a composer, not a headless mutation).
 */
import { action, assert, TESTS, Writable } from "commonfabric";
import { pattern } from "commonfabric";
import Topics from "./main.tsx";
import Topic, { type TopicComment, type TopicLink } from "./topic.tsx";

export default pattern(() => {
  const board = Topics({});
  const legacyBoard = Topics({});

  // One valid signed topic on the board, so `addTopic`'s own rejections have a
  // board to leave unchanged.
  const action_seed_topic = action(() => {
    board.addTopic.send({ title: "Seed", agentName: "Sol" });
  });

  // The child verbs are rejected on a direct instance, for the reason `setTitle`
  // already is below: a verb lives on the topic's own interface, and the board
  // demands a projection that carries none of them. A caller reaches a topic by
  // its own address and calls it there, so that is where the rejection belongs.
  const seedTopic = Topic({ title: "Seed", body: "" });

  // addTopic: empty title; blank (provided) agentName. An *omitted* agentName
  // rejects too, and `action_add_topic_unsigned` below is where that is
  // proven — there is no longer a legacy caller path that accepts it.
  const action_add_blank_title = action(() => {
    board.addTopic.send({ title: "   ", agentName: "Sol" });
  });
  const action_add_unsigned_topic = action(() => {
    board.addTopic.send({ title: "Unsigned", agentName: "   " });
  });
  const action_add_blank_legacy_agent = action(() => {
    legacyBoard.addTopic.send({ title: "must not land", agentName: " " });
  });

  // addComment: empty body; blank agentName.
  const action_blank_comment = action(() => {
    seedTopic.addComment.send({ body: "   ", agentName: "Sol" });
  });
  const action_comment_unsigned = action(() => {
    seedTopic.addComment.send({
      body: "unsigned",
      agentName: "   ",
    });
  });

  // addLink: unsafe scheme; blank URL; blank agentName.
  const action_link_unsafe = action(() => {
    seedTopic.addLink.send({
      kind: "web",
      url: "javascript:alert(1)",
      label: "evil",
      agentName: "Sol",
    });
  });
  const action_link_blank = action(() => {
    seedTopic.addLink.send({
      kind: "web",
      url: "   ",
      label: "x",
      agentName: "Sol",
    });
  });
  const action_link_unsigned = action(() => {
    seedTopic.addLink.send({
      kind: "web",
      url: "https://example.com/ok",
      label: "ok",
      agentName: "   ",
    });
  });

  // setBody: blank agentName. (An empty body is legal — clearing a body is a
  // legitimate edit — so only the signature is guarded here.)
  const action_set_body_unsigned = action(() => {
    seedTopic.setBody.send({
      body: "should not land",
      agentName: "   ",
    });
  });

  // mention / unmention: a payload that is not a reference. This is the shape
  // an inline CLI call argument produces — parsed as plain JSON, an address
  // arrives as the string it looks like. The narrowed payload does not refuse
  // it on its own (an `asCell` field is wrapped whole, without validating what
  // is behind it); the verbs read the one named field and reject on
  // `undefined`. Casts, because the point is a caller that was never
  // type-checked.
  const action_mention_text_address = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.mention as any)?.send({ topic: "fid1:notAReference" });
  });
  const action_unmention_text_address = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.unmention as any)?.send({
      topic: "fid1:notAReference",
    });
  });

  // An OMITTED `agentName`, on each verb that once tolerated one. This is the
  // half that changed: a blank signature always rejected, while an absent one
  // was the legacy caller's path and was accepted. Casts, because the point is
  // a caller written against the previous contract, which no longer type-checks.
  const action_add_topic_unsigned = action(() => {
    // deno-lint-ignore no-explicit-any
    (board.addTopic as any).send({ title: "unsigned create" });
  });
  const action_comment_unsigned_omitted = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.addComment as any).send({ body: "unsigned comment" });
  });
  const action_link_unsigned_omitted = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.addLink as any).send({ url: "https://example.com/unsigned" });
  });
  const action_set_body_unsigned_omitted = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.setBody as any).send({ body: "unsigned body" });
  });

  // setTitle: blank title; blank agentName. On a direct instance, because the
  // verb lives on the direct interface rather than the shared projection —
  // and unlike its elders, a MISSING agentName is as rejected as a blank one:
  // the verb postdates the unsigned-caller era and carries no legacy path.
  const directTopic = Topic({ title: "Keep this title" });
  // A reference is not enough: it must reference one of THIS topic's own
  // records. A cell that reads back as an object satisfies "is a reference"
  // while belonging to something else, and a verb that stamped it would write
  // into a document this topic does not own — silently, since the caller's own
  // cell would show the change and nothing here would.
  const foreignComment = new Writable<TopicComment>({
    body: "elsewhere",
    sentAt: 1,
  });
  const foreignLink = new Writable<TopicLink>({
    kind: "web",
    url: "https://example.com/elsewhere",
    label: "elsewhere",
  });
  const action_remove_foreign_comment = action(() => {
    seedTopic.removeComment.send({
      comment: foreignComment,
      agentName: "Sol",
    });
  });
  const action_edit_foreign_comment = action(() => {
    seedTopic.editComment.send({
      comment: foreignComment,
      body: "rewritten from outside",
      agentName: "Sol",
    });
  });
  const assert_foreign_comment_untouched = assert(() =>
    foreignComment.get().removedAt === undefined &&
    foreignComment.get().body === "elsewhere"
  );

  // The retraction verbs' own refusal arms. Each is a path the Coverage Check
  // named as unexercised, and each is a way a caller can be wrong that must
  // produce a value rather than a silent no-op.
  const action_remove_comment_unsigned = action(() => {
    seedTopic.removeComment.send({
      comment: foreignComment,
      agentName: "   ",
    });
  });
  const action_edit_comment_blank_body = action(() => {
    seedTopic.editComment.send({
      comment: foreignComment,
      body: "   ",
      agentName: "Sol",
    });
  });
  const action_remove_link_both_spellings = action(() => {
    seedTopic.removeLink.send({
      link: foreignLink,
      url: "https://example.com/a",
      agentName: "Sol",
    });
  });
  const action_remove_link_neither_spelling = action(() => {
    seedTopic.removeLink.send({ agentName: "Sol" });
  });
  const action_remove_link_unknown_url = action(() => {
    seedTopic.removeLink.send({
      url: "https://example.com/never-added",
      agentName: "Sol",
    });
  });
  const action_remove_foreign_link = action(() => {
    seedTopic.removeLink.send({ link: foreignLink, agentName: "Sol" });
  });
  const assert_foreign_link_untouched = assert(() =>
    foreignLink.get().removedAt === undefined
  );

  // A payload that is not a reference at all. The verb must refuse rather than
  // resolve it to nothing and report success — the same shape `mention` and
  // `unmention` are held to above.
  const action_remove_comment_text_address = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.removeComment as any)?.send({
      comment: "fid1:notAReference",
      agentName: "Sol",
    });
  });
  const action_edit_comment_text_address = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.editComment as any)?.send({
      comment: "fid1:notAReference",
      body: "rewritten",
      agentName: "Sol",
    });
  });
  const action_remove_link_text_address = action(() => {
    // deno-lint-ignore no-explicit-any
    (seedTopic.removeLink as any)?.send({
      link: "fid1:notAReference",
      agentName: "Sol",
    });
  });
  const action_edit_comment_unsigned = action(() => {
    seedTopic.editComment.send({
      comment: foreignComment,
      body: "rewritten",
      agentName: "   ",
    });
  });
  const action_remove_link_unsigned = action(() => {
    seedTopic.removeLink.send({ link: foreignLink, agentName: "   " });
  });

  // Retracting what is already retracted. A second call is not a no-op that
  // quietly succeeds: the record carries one retraction, and a caller asking
  // for another is wrong about the state.
  const retractedComments = new Writable<TopicComment[]>([]);
  const retractedLinks = new Writable<TopicLink[]>([]);
  const retractedTopic = Topic({
    title: "Already retracted",
    comments: retractedComments,
    links: retractedLinks,
  });
  const action_seed_retractable = action(() => {
    retractedTopic.addComment.send({ body: "once", agentName: "Sol" });
    retractedTopic.addLink.send({
      url: "https://example.com/once",
      agentName: "Sol",
    });
  });
  const action_retract_both = action(() => {
    retractedTopic.removeComment.send({
      comment: retractedComments.key(0),
      agentName: "Sol",
    });
    retractedTopic.removeLink.send({
      link: retractedLinks.key(0),
      agentName: "Sol",
    });
  });
  const action_retract_comment_again = action(() => {
    retractedTopic.removeComment.send({
      comment: retractedComments.key(0),
      agentName: "Sol",
    });
  });
  const action_edit_retracted_comment = action(() => {
    retractedTopic.editComment.send({
      comment: retractedComments.key(0),
      body: "rewriting a retraction",
      agentName: "Sol",
    });
  });
  const action_retract_link_again = action(() => {
    retractedTopic.removeLink.send({
      link: retractedLinks.key(0),
      agentName: "Sol",
    });
  });
  const assert_one_retraction_each = assert(() =>
    retractedTopic.commentCount === 0 &&
    (retractedComments.get()[0]?.removedAt ?? 0) > 0 &&
    retractedComments.get()[0]?.body === "once" &&
    (retractedLinks.get()[0]?.removedAt ?? 0) > 0
  );

  const action_rename_blank_title = action(() => {
    directTopic.setTitle.send({ title: "   ", agentName: "Sol" });
  });
  const action_rename_unsigned = action(() => {
    directTopic.setTitle.send({ title: "must not land", agentName: "   " });
  });

  const assert_direct_title_unchanged = assert(() =>
    directTopic.title === "Keep this title" &&
    (directTopic.titleUpdatedAt ?? 0) === 0
  );

  const assert_seeded = assert(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.title === "Seed"
  );

  // No inert entry was stored by either rejection. Read on the instance the
  // verbs were called on: asserting the board here would pass whatever the
  // verb did, because the board is not what `mention` writes to.
  const assert_no_mentions = assert(() =>
    (seedTopic.mentions ?? []).length === 0
  );

  // No topic was filed by a rejected `addTopic`.
  const assert_board_unchanged = assert(() => board.topicCount === 1);

  // The direct topic, untouched by every rejected child verb: no comments, no
  // links, empty body.
  const assert_seed_topic_untouched = assert(() =>
    (seedTopic.comments ?? []).length === 0 &&
    (seedTopic.links ?? []).length === 0 &&
    seedTopic.body === ""
  );

  const assert_legacy_board_empty = assert(() => legacyBoard.topicCount === 0);

  return {
    // Every rejection below MUST surface as a thrown handler error —
    // seventeen throwing actions, seventeen runtime errors. The exact count
    // means a
    // single verb quietly reverting to a silent early-return fails this suite;
    // the no-write assertions then prove the throw also blocked the write.
    expectRuntimeErrors: 33,
    [TESTS]: [
      { action: action_seed_topic },
      { assertion: assert_seeded },
      { action: action_add_blank_title },
      { assertion: assert_board_unchanged },
      { action: action_add_unsigned_topic },
      { assertion: assert_board_unchanged },
      { action: action_add_blank_legacy_agent },
      { assertion: assert_legacy_board_empty },
      { action: action_blank_comment },
      { assertion: assert_seed_topic_untouched },
      { action: action_comment_unsigned },
      { assertion: assert_seed_topic_untouched },
      { action: action_link_unsafe },
      { assertion: assert_seed_topic_untouched },
      { action: action_link_blank },
      { assertion: assert_seed_topic_untouched },
      { action: action_link_unsigned },
      { assertion: assert_seed_topic_untouched },
      { action: action_set_body_unsigned },
      { assertion: assert_seed_topic_untouched },
      { action: action_add_topic_unsigned },
      { assertion: assert_board_unchanged },
      { action: action_comment_unsigned_omitted },
      { assertion: assert_seed_topic_untouched },
      { action: action_link_unsigned_omitted },
      { assertion: assert_seed_topic_untouched },
      { action: action_set_body_unsigned_omitted },
      { assertion: assert_seed_topic_untouched },
      { action: action_mention_text_address },
      { assertion: assert_no_mentions },
      { action: action_unmention_text_address },
      { assertion: assert_no_mentions },
      { action: action_rename_blank_title },
      { assertion: assert_direct_title_unchanged },
      { action: action_rename_unsigned },
      { assertion: assert_direct_title_unchanged },
      { action: action_remove_foreign_comment },
      { assertion: assert_foreign_comment_untouched },
      { action: action_edit_foreign_comment },
      { assertion: assert_foreign_comment_untouched },
      { action: action_remove_comment_unsigned },
      { assertion: assert_foreign_comment_untouched },
      { action: action_edit_comment_blank_body },
      { assertion: assert_foreign_comment_untouched },
      { action: action_remove_link_both_spellings },
      { assertion: assert_foreign_link_untouched },
      { action: action_remove_link_neither_spelling },
      { assertion: assert_foreign_link_untouched },
      { action: action_remove_link_unknown_url },
      { assertion: assert_foreign_link_untouched },
      { action: action_remove_foreign_link },
      { assertion: assert_foreign_link_untouched },
      { action: action_remove_comment_text_address },
      { assertion: assert_foreign_comment_untouched },
      { action: action_edit_comment_text_address },
      { assertion: assert_foreign_comment_untouched },
      { action: action_remove_link_text_address },
      { assertion: assert_foreign_link_untouched },
      { action: action_edit_comment_unsigned },
      { assertion: assert_foreign_comment_untouched },
      { action: action_remove_link_unsigned },
      { assertion: assert_foreign_link_untouched },
      { action: action_seed_retractable },
      { action: action_retract_both },
      { assertion: assert_one_retraction_each },
      { action: action_retract_comment_again },
      { assertion: assert_one_retraction_each },
      { action: action_edit_retracted_comment },
      { assertion: assert_one_retraction_each },
      { action: action_retract_link_again },
      { assertion: assert_one_retraction_each },
    ],
  };
});
