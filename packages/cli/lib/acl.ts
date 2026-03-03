import { createSession, isDID, Session } from "@commontools/identity";
import { loadIdentity } from "./identity.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import {
  ACL,
  ACLUser,
  type Capability,
  isACLUser,
} from "@commontools/memory/acl";
import { ACLManager } from "@commontools/piece/ops";
import { experimentalOptionsFromEnv } from "./utils.ts";

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
  const runtime = new Runtime({
    apiUrl: config.apiUrl,
    experimental: experimentalOptionsFromEnv(),
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", config.apiUrl),
      spaceIdentity: session.spaceIdentity,
    }),
  });

  if (!(await runtime.healthCheck())) {
    throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
  }

  const SYNC_TIMEOUT_MS = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Sync timed out after ${SYNC_TIMEOUT_MS / 1000}s. ` +
            `This often indicates a client/server configuration mismatch ` +
            `(e.g., EXPERIMENTAL_CANONICAL_HASHING enabled on the server but not the CLI). ` +
            `Check toolshed logs for AuthorizationError details.`,
        ),
      );
    }, SYNC_TIMEOUT_MS);
  });
  try {
    await Promise.race([runtime.storageManager.synced(), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
}

// Get the current ACL for a space
export async function getAcl(
  config: SpaceConfig,
): Promise<ACL | null> {
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  const aclManager = new ACLManager(runtime, session.space);
  return await aclManager.get();
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
