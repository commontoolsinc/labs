import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { encodePointer } from "../../../memory/v2/path.ts";
import type {
  AttemptedWrite,
  CfcAddress,
  CfcDereferenceTrace,
  CfcMetadata,
  ConsumedRead,
  PreparedDigestInput,
  WritePolicyInput,
} from "./types.ts";
import { cloneCfcLabelView } from "./label-view-core.ts";

export const canonicalizeLogicalPath = (path: readonly string[]): string[] =>
  path[0] === "value" ? [...path.slice(1)] : [...path];

export const logicalPathToPointer = (path: readonly string[]): string =>
  encodePointer(canonicalizeLogicalPath(path));

const compareAddress = (left: CfcAddress, right: CfcAddress): number => {
  if (left.space !== right.space) {
    return left.space < right.space ? -1 : 1;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  const leftPointer = logicalPathToPointer(left.path);
  const rightPointer = logicalPathToPointer(right.path);
  return leftPointer < rightPointer ? -1 : leftPointer > rightPointer ? 1 : 0;
};

const compareWritePolicyInput = (
  left: WritePolicyInput,
  right: WritePolicyInput,
): number => {
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;

  // Same kind on both sides. Use a structurally meaningful sub-key
  // so canonical order is readable in debug output; fall back to the
  // canonical hash to give a total order on otherwise-distinct records.
  let primary = 0;
  switch (left.kind) {
    case "schema":
    case "structural-provenance":
    case "trusted-event":
    case "link-write": {
      const r = right as typeof left;
      primary = compareAddress(left.target, r.target);
      break;
    }
    case "custom": {
      const r = right as typeof left;
      primary = left.name < r.name ? -1 : left.name > r.name ? 1 : 0;
      break;
    }
    case "sink-request": {
      const r = right as typeof left;
      primary = left.effectId < r.effectId
        ? -1
        : left.effectId > r.effectId
        ? 1
        : 0;
      break;
    }
  }
  if (primary !== 0) return primary;
  const leftHash = hashStringOf(left);
  const rightHash = hashStringOf(right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
};

export const canonicalizeConsumedRead = (
  read: ConsumedRead,
): ConsumedRead => ({
  ...read,
  path: canonicalizeLogicalPath(read.path),
});

export const canonicalizeAttemptedWrite = (
  write: AttemptedWrite,
): AttemptedWrite => ({
  ...write,
  path: canonicalizeLogicalPath(write.path),
});

export const canonicalizeDereferenceTrace = (
  trace: CfcDereferenceTrace,
): CfcDereferenceTrace => ({
  ...trace,
  source: canonicalizeAttemptedWrite(trace.source),
  target: canonicalizeAttemptedWrite(trace.target),
});

export const canonicalizeWritePolicyInput = (
  input: WritePolicyInput,
): WritePolicyInput => {
  switch (input.kind) {
    case "schema":
      return { ...input, target: canonicalizeAttemptedWrite(input.target) };
    case "structural-provenance":
      return {
        ...input,
        target: canonicalizeAttemptedWrite(input.target),
        sources: [...input.sources].map(canonicalizeAttemptedWrite).sort(
          compareAddress,
        ),
      };
    case "trusted-event":
      return { ...input, target: canonicalizeAttemptedWrite(input.target) };
    case "link-write": {
      const cfcLabelView = cloneCfcLabelView(input.cfcLabelView);
      return {
        ...input,
        target: canonicalizeAttemptedWrite(input.target),
        source: canonicalizeAttemptedWrite(input.source),
        ...(cfcLabelView !== undefined && { cfcLabelView }),
      };
    }
    case "custom":
      return input.target === undefined
        ? input
        : { ...input, target: canonicalizeAttemptedWrite(input.target) };
    case "sink-request":
      return input;
  }
};

export const canonicalizeCfcMetadata = (
  metadata: CfcMetadata,
): CfcMetadata => ({
  version: 1,
  schemaHash: metadata.schemaHash,
  labelMap: {
    version: 1,
    entries: [...metadata.labelMap.entries].map((entry) => ({
      path: canonicalizeLogicalPath(entry.path),
      label: entry.label,
    })).sort((left, right) => {
      const leftKey = logicalPathToPointer(left.path);
      const rightKey = logicalPathToPointer(right.path);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  },
});

export const canonicalizePreparedDigestInput = (
  input: PreparedDigestInput,
): PreparedDigestInput => ({
  consumedReads: [...input.consumedReads].map(canonicalizeConsumedRead).sort(
    compareAddress,
  ),
  potentialWrites: [...input.potentialWrites].map(canonicalizeAttemptedWrite)
    .sort(compareAddress),
  writes: [...input.writes].map(canonicalizeAttemptedWrite).sort(
    compareAddress,
  ),
  dereferenceTraces: [...input.dereferenceTraces].map(
    canonicalizeDereferenceTrace,
  ).sort((left, right) => {
    const sourceCompare = compareAddress(left.source, right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }
    const targetCompare = compareAddress(left.target, right.target);
    if (targetCompare !== 0) return targetCompare;
    return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
  }),
  writePolicyInputs: [...input.writePolicyInputs].map(
    canonicalizeWritePolicyInput,
  ).sort(compareWritePolicyInput),
  implementationIdentity: input.implementationIdentity,
  trustSnapshot: input.trustSnapshot,
});

export const preparedDigestFor = (input: PreparedDigestInput): string =>
  hashStringOf(canonicalizePreparedDigestInput(input));
