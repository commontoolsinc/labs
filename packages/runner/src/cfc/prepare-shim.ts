import { hasWriteActivity } from "./canonical-activity.ts";
import { prepareBoundaryCommit } from "./prepare-engine.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import type { CfcImplementationIdentity } from "./implementation-identity.ts";
import type {
  CfcPrepareScopeOverrides,
  CfcTrustContext,
} from "./integrity-trust.ts";
import type { CfcIntegrityLabel } from "./label-algebra.ts";
import type { CfcImplementationTrustEvaluator } from "./trust-lattice.ts";

export interface PrepareCfcCommitIfNeededOptions {
  readonly enforceBoundary?: boolean;
  readonly implementationIdentity?: CfcImplementationIdentity;
  readonly actingPrincipal?: string;
  readonly trustContext?: CfcTrustContext;
  readonly executionIntegrity?: CfcIntegrityLabel;
  readonly trustEvaluator?: CfcImplementationTrustEvaluator;
}

export function isCommitBearingAttempt(
  tx: IExtendedStorageTransaction,
): boolean {
  return tx.cfcOutboxSize > 0 || hasWriteActivity(tx.journal.activity());
}

export async function prepareCfcCommitIfNeeded(
  tx: IExtendedStorageTransaction,
  options: PrepareCfcCommitIfNeededOptions = {},
): Promise<void> {
  if (!isCommitBearingAttempt(tx)) {
    return;
  }
  if (!tx.cfcRelevant) {
    return;
  }
  const prepareScopeOverrides = {
    ...(Object.hasOwn(options, "implementationIdentity")
      ? { implementationIdentity: options.implementationIdentity }
      : {}),
    ...(Object.hasOwn(options, "actingPrincipal")
      ? { actingPrincipal: options.actingPrincipal }
      : {}),
    ...(Object.hasOwn(options, "trustContext")
      ? { trustContext: options.trustContext }
      : {}),
    ...(Object.hasOwn(options, "executionIntegrity")
      ? { executionIntegrity: options.executionIntegrity }
      : {}),
  } satisfies CfcPrepareScopeOverrides;
  tx.setCfcPrepareScopeOverrides(prepareScopeOverrides);

  const prepareScope = tx.resolveCfcPrepareScopeSnapshot();
  if (options.enforceBoundary === false) {
    const digest = computeCfcActivityDigest(
      tx.journal.activity(),
      prepareScope,
    );
    tx.markCfcPrepared(digest);
    return;
  }
  await prepareBoundaryCommit(tx, {
    implementationIdentity: prepareScope.implementationIdentity,
    actingPrincipal: prepareScope.actingPrincipal,
    trustContext: prepareScope.trustContext,
    executionIntegrity: prepareScope.executionIntegrity,
    trustEvaluator: options.trustEvaluator,
  });
}
