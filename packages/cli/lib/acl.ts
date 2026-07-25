import { createSession, isDID, Session } from "@commonfabric/identity";
import { loadIdentity } from "./identity.ts";
import {
  ACLManager,
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  ACL,
  ACLUser,
  type Capability,
  isACLUser,
} from "@commonfabric/memory/acl";
import { throwOnSpaceAuthorizationError } from "./utils.ts";

export interface SpaceConfig {
  apiUrl: URL;
  identityPath: string;
  space: string;
}

// Create an identity and session from configuration.
async function loadSession(config: SpaceConfig): Promise<Session> {
  const identity = await loadIdentity(config.identityPath);
  return isDID(config.space)
    ? createSession({
      identity,
      spaceDid: config.space,
    })
    : createSession({
      identity,
      spaceName: config.space,
    });
}

// Creates a Runtime instance for ACL operations
export async function createRuntime(
  config: SpaceConfig,
  session: Session,
): Promise<Runtime> {
  // Shared first-party posture for client runtimes against a deployed API
  // (CT-1814).
  const runtime = new Runtime(runtimePresets.remoteClient({
    apiUrl: config.apiUrl,
    storageManager: StorageManager.open({
      as: session.as,
      memoryHost: new URL(config.apiUrl),
      spaceIdentity: session.spaceIdentity,
    }),
    experimental: experimentalOptionsFromEnv(Deno.env.get),
  }));

  if (!(await runtime.healthCheck())) {
    throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
  }

  await runtime.storageManager.synced();
  return runtime;
}

// Add or update an ACL entry for a DID
export async function setAclEntry(
  config: SpaceConfig,
  user: string,
  capability: Capability,
): Promise<void> {
  const userDid = userToACLUser(user);
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  const aclManager = new ACLManager(runtime, session.space);
  await aclManager.set(userDid, capability);
  // Checked AFTER the ACL access, which is what pulls the space and records any
  // denial. A denied write already rejects above; this also fails a read that
  // otherwise collapses to a silent "no ACL".
  throwOnSpaceAuthorizationError(runtime.storageManager, session.space);
}

// Remove an ACL entry for a DID
export async function removeAclEntry(
  config: SpaceConfig,
  user: string,
): Promise<void> {
  const userDid = userToACLUser(user);
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  const aclManager = new ACLManager(runtime, session.space);
  await aclManager.remove(userDid);
  throwOnSpaceAuthorizationError(runtime.storageManager, session.space);
}

// Get the current ACL for a space
export async function getAcl(
  config: SpaceConfig,
): Promise<ACL | null> {
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  const aclManager = new ACLManager(runtime, session.space);
  const acl = await aclManager.get();
  throwOnSpaceAuthorizationError(runtime.storageManager, session.space);
  return acl;
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
