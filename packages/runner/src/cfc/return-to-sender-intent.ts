import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import {
  type CfcIntentOnce,
  createCfcIntentOnce,
  type CreateCfcIntentOnceOptions,
} from "./intent-refinement.ts";

interface AuthoredByAtom {
  readonly type: "https://commonfabric.org/cfc/atom/AuthoredBy";
  readonly sender: string;
  readonly provider?: string;
}

export interface RefineCfcReturnToSenderIntentOptions<T>
  extends CreateCfcIntentOnceOptions<T> {
  readonly sourceConfidentiality: readonly unknown[];
  readonly trustedProviderPattern?: Record<string, unknown>;
}

function findAuthoredByAtom(
  sourceConfidentiality: readonly unknown[],
): AuthoredByAtom | undefined {
  return sourceConfidentiality.find((atom) =>
    matchesCfcAtomPattern(atom as never, {
      type: "https://commonfabric.org/cfc/atom/AuthoredBy",
    } as never)
  ) as AuthoredByAtom | undefined;
}

function hasTrustedProvider(
  integrity: readonly unknown[] | undefined,
  provider: string | undefined,
  customPattern?: Record<string, unknown>,
): boolean {
  if (!provider) {
    return false;
  }
  const pattern = customPattern ?? {
    type: "https://commonfabric.org/cfc/atom/TrustedProvider",
    provider,
  };
  return (integrity ?? []).some((atom) =>
    matchesCfcAtomPattern(atom as never, pattern as never)
  );
}

export function canRefineCfcReturnToSenderIntent(
  options: Pick<
    RefineCfcReturnToSenderIntentOptions<unknown>,
    "sourceConfidentiality" | "additionalIntegrity" | "trustedProviderPattern"
  >,
): boolean {
  const authoredBy = findAuthoredByAtom(options.sourceConfidentiality);
  if (!authoredBy) {
    return false;
  }
  return hasTrustedProvider(
    options.additionalIntegrity,
    authoredBy.provider,
    options.trustedProviderPattern,
  );
}

export function refineCfcReturnToSenderIntent<T>(
  sourceIntent: Pick<
    CfcIntentOnce | { id: string; integrity: readonly unknown[] },
    "id" | "integrity"
  >,
  options: RefineCfcReturnToSenderIntentOptions<T>,
): CfcIntentOnce<T> | null {
  const authoredBy = findAuthoredByAtom(options.sourceConfidentiality);
  if (
    !authoredBy ||
    !hasTrustedProvider(
      options.additionalIntegrity,
      authoredBy.provider,
      options.trustedProviderPattern,
    )
  ) {
    return null;
  }

  if (
    options.targetPrincipal !== undefined &&
    options.targetPrincipal !== authoredBy.sender
  ) {
    return null;
  }

  return createCfcIntentOnce(sourceIntent, {
    ...options,
    targetPrincipal: authoredBy.sender,
  });
}
