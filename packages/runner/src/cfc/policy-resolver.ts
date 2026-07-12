import type { CfcModulePolicyRefAtom } from "@commonfabric/api/cfc";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcModulePolicyResolver } from "./exchange-eval.ts";

export type CfcModulePolicyLoader = (
  reference: CfcModulePolicyRefAtom,
) => unknown;

/**
 * Wraps a durable manifest loader with the prepared-digest consultation
 * discipline. Present and absent exact-reference lookups are both recorded;
 * validation remains in the pure exchange evaluator.
 */
export const createTxCfcModulePolicyResolver = (
  tx: IExtendedStorageTransaction,
  load: CfcModulePolicyLoader,
): CfcModulePolicyResolver =>
(reference) => {
  let resolved: unknown;
  try {
    resolved = load(reference);
  } catch (error) {
    tx.recordCfcConsultedPolicyManifest({ reference, state: "absent" });
    throw error;
  }
  tx.recordCfcConsultedPolicyManifest({
    reference,
    state: resolved === undefined || resolved === null ? "absent" : "present",
  });
  return resolved;
};
