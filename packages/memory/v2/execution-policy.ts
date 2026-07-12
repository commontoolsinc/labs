import type { EntityDocument } from "../v2.ts";

export interface ExecutionPolicyV1 {
  version: 1;
  serverPrimaryExecution: boolean;
}

export const executionPolicyId = (space: string): string =>
  `of:${space}:execution-policy`;

export const parseExecutionPolicy = (
  document: EntityDocument | null,
): ExecutionPolicyV1 | null => {
  if (document === null) return null;
  const value = document.value;
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("serverPrimaryExecution")
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.serverPrimaryExecution !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    serverPrimaryExecution: candidate.serverPrimaryExecution,
  };
};

export const isExecutionPolicyEnabled = (
  document: EntityDocument | null,
): boolean => parseExecutionPolicy(document)?.serverPrimaryExecution === true;
