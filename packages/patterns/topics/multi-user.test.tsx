/// <cts-enable />
/**
 * Multi-user pattern test for Topics (CT-1878).
 *
 * One shared Topics board across two worker-isolated runtimes. Covers the
 * board's core multi-user promises:
 * - per-user display-name isolation (`myName` is PerUser: one shared piece,
 *   two identities, two values),
 * - concurrent comment appends from different users both land (mergeable
 *   `push` — no clobbering),
 * - topics created by either user propagate to the other, with authorship
 *   snapshots (`createdByName`, `authorName`) taken at write time.
 *
 * Cross-runtime reads use INLINE literal accesses (topics[0].comments[0]) —
 * `.map()`, loop-variable indexing, and helper calls over another runtime's
 * arrays do not resolve before a local write (see lunch-poll and scrabble
 * multi-user tests).
 */
import { action, computed, multiUserTest, pattern } from "commonfabric";
import Topics, { type TopicsOutput } from "./main.tsx";

interface Setup {
  board: TopicsOutput;
}

export const setup = pattern(() => ({
  board: Topics({}),
}));

export const gideon = pattern<{ setup: Setup }>(({ setup }) => {
  const board = setup.board;

  const action_set_name = action(() => {
    board.setMyName.send({ name: "Gideon" });
  });
  const action_start_topic = action(() => {
    board.addTopic.send({ title: "First topic" });
  });
  const action_comment = action(() => {
    const topic = board.topics?.[0];
    if (topic) topic.addComment.send({ body: "opening the thread" });
  });

  const assert_named = computed(() => board.myName === "Gideon");

  const assert_topic_created = computed(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdByName === "Gideon"
  );

  const assert_own_comment = computed(() =>
    board.topics?.[0]?.comments?.[0]?.authorName === "Gideon" &&
    board.topics?.[0]?.comments?.[0]?.body === "opening the thread" &&
    board.topics?.[0]?.commentCount === 1
  );

  // Fable commented on my topic and started a second topic; my identity is
  // untouched by Fable's name (PerUser isolation).
  const assert_sees_fable = computed(() =>
    board.topics?.[0]?.comments?.[1]?.authorName === "Fable" &&
    board.topics?.[0]?.commentCount === 2 &&
    (board.topics ?? []).length === 2 &&
    board.topics?.[1]?.createdByName === "Fable" &&
    board.myName === "Gideon"
  );

  return {
    tests: [
      { action: action_set_name },
      { assertion: assert_named },
      { action: action_start_topic },
      { assertion: assert_topic_created },
      { action: action_comment },
      { assertion: assert_own_comment },
      { label: "gideon-commented" },
      { await: "fable-done" },
      { assertion: assert_sees_fable },
    ],
  };
});

export const fable = pattern<{ setup: Setup }>(({ setup }) => {
  const board = setup.board;

  const action_set_name = action(() => {
    board.setMyName.send({ name: "Fable" });
  });
  const action_comment = action(() => {
    const topic = board.topics?.[0];
    if (topic) topic.addComment.send({ body: "seconding this" });
  });
  const action_start_second = action(() => {
    board.addTopic.send({ title: "Second topic" });
  });

  // Gideon's topic + comment propagated from his runtime.
  const assert_sees_gideon_setup = computed(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.comments?.[0]?.authorName === "Gideon" &&
    board.topics?.[0]?.commentCount === 1
  );

  // PerUser isolation: Gideon's name must not leak into this identity.
  const assert_not_named_yet = computed(() => board.myName === "");

  const assert_named = computed(() => board.myName === "Fable");

  // Both comments landed (mergeable append, no clobber), in thread order.
  const assert_both_comments = computed(() =>
    board.topics?.[0]?.commentCount === 2 &&
    board.topics?.[0]?.comments?.[0]?.authorName === "Gideon" &&
    board.topics?.[0]?.comments?.[1]?.authorName === "Fable" &&
    board.topics?.[0]?.comments?.[1]?.body === "seconding this"
  );

  const assert_second_topic = computed(() =>
    (board.topics ?? []).length === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdByName === "Fable"
  );

  return {
    tests: [
      { await: "gideon-commented" },
      { assertion: assert_sees_gideon_setup },
      { assertion: assert_not_named_yet },
      { action: action_set_name },
      { assertion: assert_named },
      { action: action_comment },
      { assertion: assert_both_comments },
      { action: action_start_second },
      { assertion: assert_second_topic },
      { label: "fable-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { gideon, fable } });
