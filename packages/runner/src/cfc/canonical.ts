import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { encodePointer } from "../../../memory/v2/path.ts";
import { stableHash } from "../traverse.ts";
import type {
  AttemptedWrite,
  CfcAddress,
  CfcDereferenceTrace,
  CfcMetadata,
  ConsumedRead,
  PreparedDigestInput,
  WritePolicyInput,
} from "./types.ts";

export const canonicalizeLogicalPath = (path: readonly string[]): string[] =>
  path[0] === "value" ? [...path.slice(1)] : [...path];

export const logicalPathToPointer = (path: readonly string[]): string =>
  encodePointer(canonicalizeLogicalPath(path));

const compareAddress = (left: CfcAddress, right: CfcAddress): number => {
  const leftKey = `${left.space}\u0000${left.id}\u0000${left.type}\u0000${
    logicalPathToPointer(left.path)
  }`;
  const rightKey = `${right.space}\u0000${right.id}\u0000${right.type}\u0000${
    logicalPathToPointer(right.path)
  }`;
  return leftKey.localeCompare(rightKey);
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
    case "link-write":
      return {
        ...input,
        target: canonicalizeAttemptedWrite(input.target),
        source: canonicalizeAttemptedWrite(input.source),
      };
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
    })).sort((left, right) =>
      logicalPathToPointer(left.path).localeCompare(
        logicalPathToPointer(right.path),
      )
    ),
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
    return targetCompare !== 0
      ? targetCompare
      : left.kind.localeCompare(right.kind);
  }),
  writePolicyInputs: [...input.writePolicyInputs].map(
    canonicalizeWritePolicyInput,
  ).sort((left, right) => stableHash(left).localeCompare(stableHash(right))),
  implementationIdentity: input.implementationIdentity,
  trustSnapshot: input.trustSnapshot,
});

export const preparedDigestFor = (input: PreparedDigestInput): string =>
  hashStringOf(canonicalizePreparedDigestInput(input));
