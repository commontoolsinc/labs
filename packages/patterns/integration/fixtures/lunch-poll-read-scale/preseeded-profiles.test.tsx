import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import type { LunchProfile } from "../../../lunch-poll/main.tsx";
import Poll from "./main.tsx";

export default pattern(() => {
  const profiles = new Writable.perSpace<LunchProfile[]>([]);
  const poll = Poll({ profiles });
  return {
    [TESTS]: [
      {
        action: action(() => {
          const first = profiles.elementById("0");
          first.set({ name: "Existing profile", avatar: "existing-avatar" });
          profiles.addUnique(first);
        }),
      },
      {
        action: action(() =>
          poll.seed.send({ voteCount: 3, voterCount: 2, optionCount: 2 })
        ),
      },
      {
        assertion: assert(() =>
          profiles.elementById("0").get().name === "Existing profile" &&
          profiles.elementById("0").get().avatar === "existing-avatar" &&
          profiles.elementById("1").get().name === "Voter 1" &&
          profiles.get().length === 2
        ),
      },
      { action: action(() => poll.claim.send({ type: "click" })) },
      {
        assertion: assert(() =>
          poll.voteCount === 3 && poll.userCount === 2 && poll.isJoined &&
          poll.votes.some((vote) =>
            vote.voter?.equals(profiles.elementById("0"))
          )
        ),
      },
    ],
  };
});
