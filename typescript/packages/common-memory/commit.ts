import type { Transaction, MemorySpace, Reference, Assertion, CommitData } from "./interface.ts";
import { assert } from "./fact.ts";

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
