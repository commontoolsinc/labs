/// <cts-enable />
/**
 * Multi-user pattern test for Topics (CT-1878).
 *
 * One shared Topics board across two worker-isolated runtimes. Covers the
 * board's core multi-user promises:
 * - every headless mutation carries its agent signature atomically,
 * - concurrent comment appends from different users both land (mergeable
 *   `push` — no clobbering),
 * - topics created by either user propagate to the other, with structured
 *   authorship snapshots taken at write time.
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

  const action_start_topic = action(() => {
    board.addTopic.send({ title: "First topic", agentName: "Sol" });
  });
  const action_comment = action(() => {
    const topic = board.topics?.[0];
    if (topic) {
      topic.addComment.send({ body: "opening the thread", agentName: "Sol" });
    }
  });

  const assert_topic_created = computed(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.createdBy?.kind === "agent" &&
    board.topics?.[0]?.createdBy?.name === "Sol"
  );

  const assert_own_comment = computed(() =>
    board.topics?.[0]?.comments?.[0]?.author?.kind === "agent" &&
    board.topics?.[0]?.comments?.[0]?.author?.name === "Sol" &&
    board.topics?.[0]?.comments?.[0]?.body === "opening the thread" &&
    board.topics?.[0]?.commentCount === 1
  );

  // Fable commented on my topic and started a second topic. Use literal paths
  // here, as required for cross-runtime reads above; aggregate length and
  // commentCount reads can remain stale until this runtime performs a write.
  const assert_sees_fable_comment = computed(() =>
    board.topics?.[0]?.comments?.[1]?.author?.name === "Fable"
  );
  const assert_fable_topic_authorship = computed(() =>
    board.topics?.[1]?.createdBy?.name === "Fable"
  );

  return {
    tests: [
      { action: action_start_topic },
      { assertion: assert_topic_created },
      { action: action_comment },
      { assertion: assert_own_comment },
      { label: "gideon-commented" },
      { await: "fable-done" },
      { assertion: assert_sees_fable_comment },
      { assertion: assert_fable_topic_authorship },
    ],
  };
});

export const fable = pattern<{ setup: Setup }>(({ setup }) => {
  const board = setup.board;

  const action_comment = action(() => {
    const topic = board.topics?.[0];
    if (topic) {
      topic.addComment.send({ body: "seconding this", agentName: "Fable" });
    }
  });
  const action_start_second = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });

  // Sol's topic + comment propagated from the other runtime.
  const assert_sees_sol_setup = computed(() =>
    (board.topics ?? []).length === 1 &&
    board.topics?.[0]?.title === "First topic" &&
    board.topics?.[0]?.comments?.[0]?.author?.name === "Sol" &&
    board.topics?.[0]?.commentCount === 1
  );

  // Both comments landed (mergeable append, no clobber), in thread order.
  const assert_both_comments = computed(() =>
    board.topics?.[0]?.commentCount === 2 &&
    board.topics?.[0]?.comments?.[0]?.author?.name === "Sol" &&
    board.topics?.[0]?.comments?.[1]?.author?.name === "Fable" &&
    board.topics?.[0]?.comments?.[1]?.body === "seconding this"
  );

  const assert_second_topic = computed(() =>
    (board.topics ?? []).length === 2 &&
    board.topics?.[1]?.title === "Second topic" &&
    board.topics?.[1]?.createdBy?.name === "Fable"
  );

  return {
    tests: [
      { await: "gideon-commented" },
      { assertion: assert_sees_sol_setup },
      { action: action_comment },
      { assertion: assert_both_comments },
      { action: action_start_second },
      { assertion: assert_second_topic },
      { label: "fable-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { gideon, fable } });
