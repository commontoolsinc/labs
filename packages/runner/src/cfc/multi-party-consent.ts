import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type { Labels } from "../storage/interface.ts";
import { toHex } from "./shared.ts";

export interface CfcConsentTimeRange {
  readonly start: number;
  readonly end: number;
}

export interface CfcConsentHoursRange {
  readonly start: number;
  readonly end: number;
}

export interface CfcMultiPartyConsentConstraints {
  readonly onlyFuture?: boolean;
  readonly hoursRange?: CfcConsentHoursRange;
}

export interface CfcMultiPartyConsentOutputConstraints {
  readonly maxResults: number;
  readonly allowEmptyResult: boolean;
  readonly minimumGranularity: number;
}

export interface CfcMultiPartyConsentEvidence {
  readonly renderRef?: unknown;
  readonly snapshotDigest?: string;
  readonly timestamp: number;
}

export interface CfcMultiPartyConsentIntent {
  readonly id: string;
  readonly participant: string;
  readonly operation: string;
  readonly sharedWith: readonly string[];
  readonly inputScope: {
    readonly timeRange: CfcConsentTimeRange;
    readonly constraints?: CfcMultiPartyConsentConstraints;
  };
  readonly outputConstraints: CfcMultiPartyConsentOutputConstraints;
  readonly evidence: CfcMultiPartyConsentEvidence;
  readonly exp: number;
}

export interface CreateCfcMultiPartyConsentIntentOptions
  extends Omit<CfcMultiPartyConsentIntent, "id"> {}

export type CfcMultiPartyConsentValidationResult =
  | {
    readonly valid: true;
    readonly effectiveScope: {
      readonly participants: readonly string[];
      readonly timeRange: CfcConsentTimeRange;
      readonly constraints: CfcMultiPartyConsentConstraints;
      readonly maxResults: number;
      readonly allowEmptyResult: boolean;
      readonly minimumGranularity: number;
    };
  }
  | {
    readonly valid: false;
    readonly error:
      | "participant_mismatch"
      | "operation_mismatch"
      | "consent_expired"
      | "scope_disjoint";
  };

export interface ValidateCfcMultiPartyConsentOptions {
  readonly now?: () => number;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameParticipantSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function intersectTimeRanges(
  ranges: readonly CfcConsentTimeRange[],
): CfcConsentTimeRange | undefined {
  if (ranges.length === 0) {
    return undefined;
  }
  const start = Math.max(...ranges.map((range) => range.start));
  const end = Math.min(...ranges.map((range) => range.end));
  return start < end ? { start, end } : undefined;
}

function intersectHoursRanges(
  ranges: readonly (CfcConsentHoursRange | undefined)[],
): CfcConsentHoursRange | undefined {
  const present = ranges.filter((range) => range !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  const start = Math.max(...present.map((range) => range.start));
  const end = Math.min(...present.map((range) => range.end));
  return start < end ? { start, end } : undefined;
}

export function deriveCfcMultiPartyConsentIntentId(
  options: Omit<CfcMultiPartyConsentIntent, "id">,
): string {
  const hash = canonicalHash(
    storableFromNativeValue({
      participant: options.participant,
      operation: options.operation,
      sharedWith: sortStrings(options.sharedWith),
      inputScope: options.inputScope,
      outputConstraints: options.outputConstraints,
      evidence: options.evidence,
      exp: options.exp,
    }),
  );
  return `cfc:multi-party-consent:${toHex(hash.hash)}`;
}

export function createCfcMultiPartyConsentIntent(
  options: CreateCfcMultiPartyConsentIntentOptions,
): CfcMultiPartyConsentIntent {
  return {
    id: deriveCfcMultiPartyConsentIntentId(options),
    participant: options.participant,
    operation: options.operation,
    sharedWith: sortStrings(options.sharedWith),
    inputScope: options.inputScope,
    outputConstraints: options.outputConstraints,
    evidence: options.evidence,
    exp: options.exp,
  };
}

export function validateCfcMultiPartyConsent(
  consents: readonly CfcMultiPartyConsentIntent[],
  options: ValidateCfcMultiPartyConsentOptions = {},
): CfcMultiPartyConsentValidationResult {
  if (consents.length === 0) {
    return { valid: false, error: "participant_mismatch" };
  }

  const now = options.now ?? (() => Date.now());
  const participants = sortStrings(
    consents.map((consent) => consent.participant),
  );
  const operation = consents[0].operation;
  for (const consent of consents) {
    if (consent.operation !== operation) {
      return { valid: false, error: "operation_mismatch" };
    }
    if (now() > consent.exp) {
      return { valid: false, error: "consent_expired" };
    }
    if (
      !sameParticipantSet(
        sortStrings(consent.sharedWith),
        participants,
      )
    ) {
      return { valid: false, error: "participant_mismatch" };
    }
  }

  const timeRange = intersectTimeRanges(
    consents.map((consent) => consent.inputScope.timeRange),
  );
  if (!timeRange) {
    return { valid: false, error: "scope_disjoint" };
  }

  const hoursRange = intersectHoursRanges(
    consents.map((consent) => consent.inputScope.constraints?.hoursRange),
  );
  if (
    consents.some((consent) => consent.inputScope.constraints?.hoursRange) &&
    !hoursRange
  ) {
    return { valid: false, error: "scope_disjoint" };
  }

  return {
    valid: true,
    effectiveScope: {
      participants,
      timeRange,
      constraints: {
        onlyFuture: consents.some((consent) =>
          consent.inputScope.constraints?.onlyFuture
        ),
        ...(hoursRange ? { hoursRange } : {}),
      },
      maxResults: Math.min(
        ...consents.map((consent) => consent.outputConstraints.maxResults),
      ),
      allowEmptyResult: consents.every((consent) =>
        consent.outputConstraints.allowEmptyResult
      ),
      minimumGranularity: Math.max(
        ...consents.map((consent) =>
          consent.outputConstraints.minimumGranularity
        ),
      ),
    },
  };
}

export function deriveCfcConsentedByAtom(
  consents: readonly Pick<CfcMultiPartyConsentIntent, "id">[],
): {
  readonly type: "https://commonfabric.org/cfc/atom/ConsentedBy";
  readonly consents: readonly string[];
} {
  return {
    type: "https://commonfabric.org/cfc/atom/ConsentedBy",
    consents: sortStrings(consents.map((consent) => consent.id)),
  };
}

export function deriveCfcMultiPartyResultLabels(options: {
  readonly consents: readonly CfcMultiPartyConsentIntent[];
  readonly codeHash: string;
}): Labels {
  const participants = sortStrings(
    options.consents.map((consent) => consent.participant),
  );
  return {
    classification: [[{
      type: "https://commonfabric.org/cfc/atom/MultiPartyResult",
      participants,
    }]],
    integrity: [
      {
        type: "https://commonfabric.org/cfc/atom/ComputedBy",
        codeHash: options.codeHash,
      },
      deriveCfcConsentedByAtom(options.consents),
    ],
  };
}
