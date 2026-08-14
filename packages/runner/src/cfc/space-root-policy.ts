import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CfcEnforcementMode, CfcFlowLabelsMode } from "./types.ts";

/** Returns the ambient confidentiality policy for a space root. */
export function spaceRootConfidentiality(
  enforcementMode: CfcEnforcementMode,
  flowLabelsMode: CfcFlowLabelsMode,
  space: MemorySpace,
): readonly CfcAtom[] | undefined {
  return enforcementMode === "disabled" || flowLabelsMode !== "persist"
    ? undefined
    : [cfcAtom.space(space)];
}
