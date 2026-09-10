/**
 * Document addresses used to repair a rejected transaction in one memory space.
 * Footprints retain branch and scope names; an authenticated session supplies
 * the identity that resolves each scope instance.
 */

import {
  type BranchName,
  type CellScope,
  type ClientCommit,
  type CommitRepairAddress,
  DEFAULT_BRANCH,
  type EntityId,
  ProtocolError,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "../v2.ts";

export type { CommitRepairAddress } from "../v2.ts";

/** A repair address resolved under the transaction's authenticated identity. */
export type ResolvedCommitRepairAddress = CommitRepairAddress & {
  readonly scopeKey: ScopeKey;
};

/**
 * Returns the distinct document addresses in a commit's writes and both read
 * sets, in first-encounter order. Paths and read versions share a document
 * address; different branches and scopes retain separate addresses. SQLite
 * statements contribute their declared document reads, not a synthetic target.
 */
export function getCommitRepairFootprint(
  commit: Pick<ClientCommit, "branch" | "operations" | "reads">,
): CommitRepairAddress[] {
  const branch = commit.branch ?? DEFAULT_BRANCH;
  const seen = new Map<BranchName, Map<CellScope, Set<EntityId>>>();
  const addresses: CommitRepairAddress[] = [];
  const add = (
    id: EntityId,
    scope: CellScope = "space",
    readBranch: BranchName = branch,
  ) => {
    let scopes = seen.get(readBranch);
    if (scopes === undefined) {
      scopes = new Map();
      seen.set(readBranch, scopes);
    }
    let ids = scopes.get(scope);
    if (ids === undefined) {
      ids = new Set();
      scopes.set(scope, ids);
    }
    if (ids.has(id)) return;
    ids.add(id);
    addresses.push({ branch: readBranch, id, scope });
  };

  for (const operation of commit.operations) {
    switch (operation.op) {
      case "set":
      case "patch":
      case "delete":
      case "apply-op":
      case "release-op-field":
        add(operation.id, operation.scope);
        break;
      case "sqlite":
        break;
      default:
        unexpectedOperation(operation);
    }
  }
  for (const read of commit.reads.confirmed) {
    add(read.id, read.scope, read.branch);
  }
  for (const read of commit.reads.pending) {
    add(read.id, read.scope);
  }
  return addresses;
}

/**
 * Resolves a repair address using the memory protocol's scope identity rules.
 * Throws `ProtocolError` when the identity cannot name the required instance.
 */
export function resolveCommitRepairAddress(
  address: CommitRepairAddress,
  identity: ScopeKeyIdentity,
): ResolvedCommitRepairAddress {
  return { ...address, scopeKey: resolveScopeKey(address.scope, identity) };
}

/** Refuses an operation without a defined document-footprint rule. */
function unexpectedOperation(_operation: never): never {
  throw new ProtocolError("Unsupported operation in commit repair footprint");
}
