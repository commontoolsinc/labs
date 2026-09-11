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
          poll.seed.send({ voteCount: 1184, voterCount: 87, optionCount: 14 })
        ),
      },
      { action: action(() => poll.claim.send({ type: "click" })) },
      {
        assertion: assert(() =>
          poll.voteCount === 1184 && poll.userCount === 87 &&
          poll.optionCount === 14 && poll.isJoined
        ),
      },
      { render: poll[UI], readBudget: { total: 236000, perRun: 96000 } },
      {
        action: action(() =>
          poll.castVote.send({ optionId: "option-0", voteType: "yellow" })
        ),
      },
      { render: poll[UI], readBudget: { total: 214000, perRun: 96000 } },
      {
        assertion: assert(() =>
          poll.voteCount === 1184 &&
          poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
        ),
      },
    ],
  };
});
