import { action, assert, pattern, TESTS } from "commonfabric";
import Nested from "./nested.tsx";
import Mapped from "./mapped.tsx";

export default pattern(() => {
  const nested = Nested({});
  const mapped = Mapped({});
  return {
    [TESTS]: [
      {
        action: action(() => {
          nested.cast.send({ key: "alice", optionId: "one", color: "green" });
          mapped.cast.send({ key: "alice", optionId: "one", color: "green" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors[0] === "green" &&
          mapped.rows[0].color === "green"
        ),
      },
      {
        action: action(() => {
          nested.cast.send({ key: "alice", optionId: "one", color: "yellow" });
          mapped.cast.send({ key: "alice", optionId: "one", color: "yellow" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors[0] === "yellow" &&
          mapped.rows[0].color === "yellow"
        ),
      },
    ],
  };
});
