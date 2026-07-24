/**
 * Rejection-path tests for the Topics mutating verbs (verb contract rule 4,
 * docs/plans/pattern-verb-contract.md: rejection is a value, never a silent
 * no-op). Every action here makes a verb throw, so the runtime errors are
 * expected (`allowRuntimeErrors`); each assertion then verifies the write did
 * NOT land. Happy and legacy paths live in topics.test.tsx — including the UI
 * composer wrappers, whose silent guards are correct behavior (an empty draft
 * is a non-event in a composer, not a headless mutation).
 */
import { action, computed } from "commonfabric";
import { pattern } from "commonfabric";
import Topics from "./main.tsx";

export default pattern(() => {
  const board = Topics({});
  const legacyBoard = Topics({});

  // One valid signed topic so the child-verb rejections have a target.
  const action_seed_topic = action(() => {
    board.addTopic.send({ title: "Seed", agentName: "Sol" });
  });

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
    board.topics?.[0]?.addComment.send({ body: "   ", agentName: "Sol" });
  });
  const action_comment_unsigned = action(() => {
    board.topics?.[0]?.addComment.send({
      body: "unsigned",
      agentName: "   ",
    });
  });

  // addLink: unsafe scheme; blank URL; blank agentName.
  const action_link_unsafe = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "web",
      url: "javascript:alert(1)",
      label: "evil",
      agentName: "Sol",
    });
  });
  const action_link_blank = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "web",
      url: "   ",
      label: "x",
      agentName: "Sol",
    });
  });
  const action_link_unsigned = action(() => {
    board.topics?.[0]?.addLink.send({
      kind: "web",
      url: "https://example.com/ok",
      label: "ok",
      agentName: "   ",
    });
  });

  // setBody: blank agentName. (An empty body is legal — clearing a body is a
  // legitimate edit — so only the signature is guarded here.)
  const action_set_body_unsigned = action(() => {
    board.topics?.[0]?.setBody.send({
      body: "should not land",
      agentName: "   ",
    });
  });

  const assert_seeded = computed(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.title === "Seed"
  );

  // The one seeded topic, untouched: no comments, no links, empty body.
  const assert_board_unchanged = computed(() =>
    board.topicCount === 1 &&
    board.topics?.[0]?.commentCount === 0 &&
    (board.topics?.[0]?.links ?? []).length === 0 &&
    board.topics?.[0]?.body === ""
  );

  const assert_legacy_board_empty = computed(() =>
    legacyBoard.topicCount === 0
  );

  return {
    // Every rejection below surfaces as a thrown handler error by design.
    allowRuntimeErrors: true,
    tests: [
      { action: action_seed_topic },
      { assertion: assert_seeded },
      { action: action_add_blank_title },
      { assertion: assert_board_unchanged },
      { action: action_add_unsigned_topic },
      { assertion: assert_board_unchanged },
      { action: action_add_blank_legacy_agent },
      { assertion: assert_legacy_board_empty },
      { action: action_blank_comment },
      { assertion: assert_board_unchanged },
      { action: action_comment_unsigned },
      { assertion: assert_board_unchanged },
      { action: action_link_unsafe },
      { assertion: assert_board_unchanged },
      { action: action_link_blank },
      { assertion: assert_board_unchanged },
      { action: action_link_unsigned },
      { assertion: assert_board_unchanged },
      { action: action_set_body_unsigned },
      { assertion: assert_board_unchanged },
    ],
  };
});
