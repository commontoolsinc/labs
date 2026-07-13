import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { Runtime } from "@commonfabric/runner";
import { createRuntime, loadSession, type SpaceConfig } from "./acl.ts";

export interface ExecutionPolicy {
  readonly version: 1;
  readonly serverPrimaryExecution: boolean;
}

export type ExecutionPolicyStatus = "enabled" | "disabled" | "absent";

const policyId = (space: MemorySpace): URI => `of:${space}:execution-policy`;

export async function writeExecutionPolicy(
  runtime: Runtime,
  space: MemorySpace,
  enabled: boolean,
): Promise<void> {
  const tx = runtime.edit();
  const written = tx.write({
    space,
    id: policyId(space),
    type: "application/json",
    path: [],
  }, {
    value: { version: 1, serverPrimaryExecution: enabled },
  });
  if (written.error !== undefined) {
    const error = new Error(written.error.message);
    error.name = written.error.name;
    throw error;
  }
  const result = await tx.commit();
  if (result.error !== undefined) {
    const error = new Error(result.error.message);
    error.name = result.error.name;
    throw error;
  }
  await runtime.storageManager.synced();
}

export async function readExecutionPolicy(
  runtime: Runtime,
  space: MemorySpace,
): Promise<ExecutionPolicyStatus> {
  const cell = runtime.getCellFromEntityId<unknown>(
    space,
    policyId(space),
  );
  await cell.sync();
  const value = cell.get();
  if (
    value === null || typeof value !== "object" ||
    !("version" in value) || value.version !== 1 ||
    !("serverPrimaryExecution" in value) ||
    typeof value.serverPrimaryExecution !== "boolean"
  ) {
    return "absent";
  }
  return value.serverPrimaryExecution ? "enabled" : "disabled";
}

export async function setSpaceExecutionPolicy(
  config: SpaceConfig,
  enabled: boolean,
): Promise<void> {
  const session = await loadSession(config);
  // In off/observe ACL modes the execution-policy switch deliberately accepts
  // only immutable implicit authority: the space identity or a configured
  // service DID. Named-space sessions already retain their derived space key
  // for ACL genesis, so use that same authority for this owner-only commit.
  // Raw DID sessions have no derived key and continue to use the supplied
  // operator identity (which may be the space key, a service DID, or an ACL
  // OWNER when enforcement is active).
  const authoritySession = session.spaceIdentity === undefined
    ? session
    : { ...session, as: session.spaceIdentity };
  await using runtime = await createRuntime(config, authoritySession);
  await writeExecutionPolicy(runtime, session.space, enabled);
}

export async function getSpaceExecutionPolicy(
  config: SpaceConfig,
): Promise<ExecutionPolicyStatus> {
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  return await readExecutionPolicy(runtime, session.space);
}
