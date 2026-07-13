import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Runtime } from "@commonfabric/runner";
import { createRuntime, loadSession, type SpaceConfig } from "./acl.ts";

export interface ExecutionPolicy {
  readonly version: 1;
  readonly serverPrimaryExecution: boolean;
}

export type ExecutionPolicyStatus = "enabled" | "disabled" | "absent";

const policyId = (space: MemorySpace): string => `of:${space}:execution-policy`;

export async function writeExecutionPolicy(
  runtime: Runtime,
  space: MemorySpace,
  enabled: boolean,
): Promise<void> {
  const tx = runtime.edit();
  runtime.getCell<ExecutionPolicy>(space, policyId(space), undefined, tx).set({
    version: 1,
    serverPrimaryExecution: enabled,
  });
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
  const cell = runtime.getCell<unknown>(
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
  await using runtime = await createRuntime(config, session);
  await writeExecutionPolicy(runtime, session.space, enabled);
}

export async function getSpaceExecutionPolicy(
  config: SpaceConfig,
): Promise<ExecutionPolicyStatus> {
  const session = await loadSession(config);
  await using runtime = await createRuntime(config, session);
  return await readExecutionPolicy(runtime, session.space);
}
