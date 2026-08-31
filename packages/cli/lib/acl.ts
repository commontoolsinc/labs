import { ACLManager } from "@commonfabric/runner";
import {
  ACL,
  ACLUser,
  type Capability,
  isACLUser,
} from "@commonfabric/memory/acl";
import {
  loadPieces,
  type PieceResolutionDeps,
  type SpaceConfig,
} from "./piece.ts";
import { throwOnSpaceAuthorizationError } from "./utils.ts";
import { noteWroteTo } from "./write-receipt.ts";

// Open the space and hand an ACLManager to `run`. The ACL document is
// addressed by the space DID and read through the ACLManager, so the space
// cell's contents are never needed here and their sync is deferred.
async function withAcl<T>(
  config: SpaceConfig,
  run: (acl: ACLManager) => Promise<T>,
  options: { writes?: boolean } = {},
  deps: PieceResolutionDeps = {},
): Promise<T> {
  const pieces = await (deps.loadPieces ?? loadPieces)({
    ...config,
    deferSpaceCellSync: true,
  });
  const runtime = pieces.runtime;
  // A connection opened here is closed here. One the caller supplied outlives
  // the call, and closing its runtime would take down a socket still in use.
  await using _opened = deps.loadPieces ? undefined : runtime;
  const space = pieces.getSpace();
  const result = await run(new ACLManager(runtime, space));
  // Before the authorization check below, which throws on a denial recorded
  // during the access — after a write that already landed. A receipt owed for
  // a completed write is not the check's to withhold.
  if (options.writes === true) noteWroteTo(config.space);
  // Checked AFTER the ACL access, which is what pulls the space and records any
  // denial. A denied write already rejects above; this also fails a read that
  // otherwise collapses to a silent "no ACL".
  throwOnSpaceAuthorizationError(runtime.storageManager, space);
  return result;
}

// Add or update an ACL entry for a DID
export async function setAclEntry(
  config: SpaceConfig,
  user: string,
  capability: Capability,
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const userDid = userToACLUser(user);
  await withAcl(config, (acl) => acl.set(userDid, capability), {
    writes: true,
  }, deps);
}

// Remove an ACL entry for a DID
export async function removeAclEntry(
  config: SpaceConfig,
  user: string,
  deps: PieceResolutionDeps = {},
): Promise<void> {
  const userDid = userToACLUser(user);
  await withAcl(config, (acl) => acl.remove(userDid), { writes: true }, deps);
}

// Get the current ACL for a space
export async function getAcl(
  config: SpaceConfig,
  deps: PieceResolutionDeps = {},
): Promise<ACL | null> {
  return await withAcl(config, (acl) => acl.get(), {}, deps);
}

// Use "ANYONE" on the command line to map to "*"
// to avoid shell expansion.
function userToACLUser(user: string): ACLUser {
  user = user === "ANYONE" ? "*" : user;
  if (!isACLUser(user)) {
    throw new Error(`${user} is not "ANYONE" or a valid DID.`);
  }
  return user as ACLUser;
}
