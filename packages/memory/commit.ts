import type {
  Assertion,
  Commit,
  CommitData,
  CommitFact,
  Fact,
  MemorySpace,
  Revision,
  Transaction,
} from "./interface.ts";
import type { HashObject } from "@commonfabric/data-model/value-hash";
import { assert } from "./fact.ts";
import { hashObjectFromString } from "@commonfabric/data-model/value-hash";

export const COMMIT_LOG_TYPE = "application/commit+json" as const;
export const create = <Space extends MemorySpace>({
  space,
  cause,
  since = ((cause as { is?: { since?: number } })?.is?.since ?? -1) + 1,
  transaction,
}: {
  space: Space;
  since?: number;
  transaction: Transaction;
  cause?: HashObject<Assertion> | Assertion | null | undefined;
}): Assertion<typeof COMMIT_LOG_TYPE, Space, CommitData> =>
  assert({
    the: COMMIT_LOG_TYPE,
    of: space,
    is: {
      since,
      transaction,
    },
    cause,
  });

export const toRevision = (
  commit: Commit,
): Revision<CommitFact> => {
  const [[space, attributes]] = Object.entries(commit);
  const [[cause, { is }]] = Object.entries(attributes[COMMIT_LOG_TYPE]);

  return {
    ...assert({
      the: COMMIT_LOG_TYPE,
      of: space as MemorySpace,
      is,
      cause: hashObjectFromString(cause) as HashObject<Fact>,
    }),
    since: is.since,
  };
};

/**
 * Takes a `Commit` and returns all the changes as an array of fact revisions,
 * where the first one is the commit itself.
 */
export const toChanges = function* (
  source: Commit,
): Iterable<Revision<Fact>> {
  const commit = toRevision(source);
  const { since, transaction } = commit.is;
  for (const [of, attributes] of Object.entries(transaction.args.changes)) {
    for (const [the, revision] of Object.entries(attributes)) {
      for (const [cause, state] of Object.entries(revision)) {
        if (state !== true) {
          const { is } = state;
          const change = is == null
            ? { the, of, cause: hashObjectFromString(cause), since }
            : { the, of, is, cause: hashObjectFromString(cause), since };
          yield change as Revision<Fact>;
        }
      }
    }
  }
};
