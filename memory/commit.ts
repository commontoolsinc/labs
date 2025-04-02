import type {
  Assertion,
  Commit,
  CommitData,
  Fact,
  MemorySpace,
  Reference,
  Transaction,
} from "./interface.ts";
import { assert } from "./fact.ts";
import { fromString } from "merkle-reference";

export const the = "application/commit+json" as const;
export const create = <Space extends MemorySpace>({
  space,
  cause,
  since = ((cause as { is?: { since?: number } })?.is?.since ?? -1) + 1,
  transaction,
}: {
  space: Space;
  since?: number;
  transaction: Transaction;
  cause?: Reference<Assertion> | Assertion | null | undefined;
}): Assertion<typeof the, Space, CommitData> =>
  assert({
    the,
    of: space,
    is: {
      since,
      transaction,
    },
    cause,
  });

export const toFact = (commit: Commit) => {
  const [[space, attributes]] = Object.entries(commit);
  const [[cause, { is }]] = Object.entries(attributes[the]);

  return assert({
    the,
    of: space as MemorySpace,
    is,
    cause: fromString(cause) as Reference<Fact>,
  });
};
