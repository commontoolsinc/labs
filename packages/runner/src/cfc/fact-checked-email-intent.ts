import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import {
  type CfcIntentOnce,
  createCfcIntentOnce,
  type CreateCfcIntentOnceOptions,
} from "./intent-refinement.ts";

const DEFAULT_FACT_CHECKED_PATTERN = {
  type: "https://commonfabric.org/cfc/atom/FactChecked",
} as const;

export interface FactCheckedRootIntentParameters {
  readonly to?: string;
  readonly requiresFactChecked?: boolean;
}

export interface RefineCfcFactCheckedEmailSendOptions<T>
  extends CreateCfcIntentOnceOptions<T> {
  readonly recipient: string;
  readonly factCheckedPattern?: Record<string, unknown>;
}

function hasIntegrityAtom(
  integrity: readonly unknown[] | undefined,
  pattern: Record<string, unknown>,
): boolean {
  return (integrity ?? []).some((atom) =>
    matchesCfcAtomPattern(atom as never, pattern as never)
  );
}

export function canRefineCfcFactCheckedEmailSendIntent<
  T extends FactCheckedRootIntentParameters,
>(
  rootIntent: Pick<CfcIntentOnce<T>, "parameters">,
  options: Pick<
    RefineCfcFactCheckedEmailSendOptions<unknown>,
    "recipient" | "additionalIntegrity" | "factCheckedPattern"
  >,
): boolean {
  const rootRecipient = rootIntent.parameters.to;
  if (
    typeof rootRecipient === "string" && rootRecipient !== options.recipient
  ) {
    return false;
  }
  if (rootIntent.parameters.requiresFactChecked !== true) {
    return true;
  }
  return hasIntegrityAtom(
    options.additionalIntegrity,
    options.factCheckedPattern ?? DEFAULT_FACT_CHECKED_PATTERN,
  );
}

export function refineCfcFactCheckedEmailSendIntent<
  TRoot extends FactCheckedRootIntentParameters,
  TSend,
>(
  rootIntent: Pick<CfcIntentOnce<TRoot>, "id" | "integrity" | "parameters">,
  options: RefineCfcFactCheckedEmailSendOptions<TSend>,
): CfcIntentOnce<TSend> | null {
  if (
    !canRefineCfcFactCheckedEmailSendIntent(rootIntent, {
      recipient: options.recipient,
      additionalIntegrity: options.additionalIntegrity,
      factCheckedPattern: options.factCheckedPattern,
    })
  ) {
    return null;
  }
  return createCfcIntentOnce(rootIntent, options);
}
