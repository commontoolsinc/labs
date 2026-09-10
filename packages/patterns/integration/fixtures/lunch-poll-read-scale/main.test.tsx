import { action, assert, pattern, TESTS } from "commonfabric";
import Poll from "./main.tsx";

export default pattern(() => {
  const poll = Poll({});
  return {
    [TESTS]: [
      {
        action: action(() =>
          poll.seed.send({ voteCount: 74, voterCount: 8, optionCount: 14 })
        ),
      },
      { action: action(() => poll.claim.send({})) },
      {
        assertion: assert(() =>
          poll.voteCount === 74 && poll.userCount === 8 &&
          poll.optionCount === 14 && poll.isJoined
        ),
      },
      {
        action: action(() =>
          poll.castVote.send({ optionId: "option-0", voteType: "yellow" })
        ),
      },
      {
        assertion: assert(() =>
          poll.voteCount === 74 &&
          poll.votes.filter((vote) => vote.voteType === "yellow").length === 1
        ),
      },
    ],
  };
});
