import type { CommitError } from "../storage/interface.ts";

const CFC_COMMIT_ERROR_NAMES = new Set<string>([
  "CfcPrepareRequiredError",
  "CfcPreparedDigestMismatchError",
  "CfcPrepareSchemaUnavailableError",
  "CfcSchemaHashMismatchError",
  "CfcInputRequirementViolationError",
  "CfcOutputTransitionViolationError",
  "CfcPolicyNonConvergenceError",
]);

type SanitizedErrorRecord = {
  readonly name: string;
  readonly requirement?: string;
  readonly space?: string;
  readonly id?: string;
  readonly type?: string;
  readonly path?: string;
  readonly sourcePath?: string;
  readonly projectionPath?: string;
  readonly requiredReadPath?: string;
  readonly predicatePath?: string;
  readonly fuel?: number;
  readonly maxConfidentialityCount?: number;
  readonly requiredIntegrityCount?: number;
  readonly digestMismatch?: true;
  readonly schemaHashMismatch?: true;
};

function readOptionalStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === "number" ? value : undefined;
}

function readArrayCountField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return Array.isArray(value) ? value.length : undefined;
}

export function isCfcCommitError(error: unknown): error is CommitError {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && CFC_COMMIT_ERROR_NAMES.has(name);
}

export function toCfcRejectLog(
  error: unknown,
): Readonly<SanitizedErrorRecord> | undefined {
  if (!isCfcCommitError(error)) {
    return undefined;
  }

  const record = error as unknown as Record<string, unknown>;
  const base: SanitizedErrorRecord = {
    name: String(record.name),
    requirement: readOptionalStringField(record, "requirement"),
    space: readOptionalStringField(record, "space"),
    id: readOptionalStringField(record, "id"),
    type: readOptionalStringField(record, "type"),
    path: readOptionalStringField(record, "path"),
    sourcePath: readOptionalStringField(record, "sourcePath"),
    projectionPath: readOptionalStringField(record, "projectionPath"),
    requiredReadPath: readOptionalStringField(record, "requiredReadPath"),
    predicatePath: readOptionalStringField(record, "predicatePath"),
    fuel: readOptionalNumberField(record, "fuel"),
    maxConfidentialityCount: readArrayCountField(record, "maxConfidentiality"),
    requiredIntegrityCount: readArrayCountField(record, "requiredIntegrity"),
  };

  if (base.name === "CfcPreparedDigestMismatchError") {
    return {
      ...base,
      digestMismatch: true,
    };
  }

  if (base.name === "CfcSchemaHashMismatchError") {
    return {
      ...base,
      schemaHashMismatch: true,
    };
  }

  return base;
}
