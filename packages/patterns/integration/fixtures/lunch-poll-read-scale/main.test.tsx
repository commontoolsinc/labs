import { action, assert, pattern, TESTS, UI } from "commonfabric";
import Poll from "./main.tsx";

/** Collects interval diagnostics; render steps declare the enforced limits. */
export const readBudgets = {};

export default pattern(() => {
  const poll = Poll({});
  return {
    [TESTS]: [
      {
        action: action(() =>
          poll.seed.send({ voteCount: 74, voterCount: 8, optionCount: 14 })
        ),
      },
      { action: action(() => poll.claim.send({ type: "click" })) },
      {
        assertion: assert(() =>
          poll.voteCount === 74 && poll.userCount === 8 &&
          poll.optionCount === 14 && poll.isJoined
        ),
      },
      { render: poll[UI], readBudget: { total: 36000, perRun: 14000 } },
      {
        action: action(() =>
          poll.castVote.send({ optionId: "option-0", voteType: "yellow" })
        ),
      },
      { render: poll[UI], readBudget: { total: 30000, perRun: 14000 } },
      {
        assertion: assert(() =>
          poll.voteCount === 74 &&
          poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
        ),
      },
    ],
  };
});
