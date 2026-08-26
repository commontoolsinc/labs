/**
 * Rejection-path tests for the Topics mutating verbs (verb contract rule 4,
 * docs/plans/pattern-verb-contract.md: rejection is a value, never a silent
 * no-op). Every action here makes a verb throw, so the runtime errors are
 * required (`expectRuntimeErrors: 17` — exact count, so a rejection quietly
 * reverting to a silent return fails the suite); each assertion then verifies
 * the write did NOT land. Happy and legacy paths live in topics.test.tsx — including the UI
 * composer wrappers, whose silent guards are correct behavior (an empty draft
 * is a non-event in a composer, not a headless mutation).
 */
import { action, assert, TESTS } from "commonfabric";
import { pattern } from "commonfabric";
import Topics from "./main.tsx";
import Topic from "./topic.tsx";

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
  // is the legacy caller path and stays accepted — covered in topics.test.tsx.
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
    // Every rejection below MUST surface as a thrown handler error — thirteen
    // throwing actions, thirteen runtime errors. The exact count means a
    // single verb quietly reverting to a silent early-return fails this suite;
    // the no-write assertions then prove the throw also blocked the write.
    expectRuntimeErrors: 17,
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
    ],
  };
});
