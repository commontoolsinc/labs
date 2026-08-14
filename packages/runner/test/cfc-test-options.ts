/** Observe-mode flow labeling with every unrelated CFC control disabled. */
export const CFC_OBSERVE_FLOW_OPTIONS = {
  cfcEnforcementMode: "observe",
  cfcFlowLabels: "persist",
  cfcWriteFloor: "off",
  cfcTriggerReadGating: false,
  cfcPolicyEvaluation: "off",
  cfcLabelMetadataProtection: "off",
  cfcDeclaredMonotonicity: "off",
} as const;

/** The pre-enforcement posture for tests whose subject is not CFC behavior. */
export const LEGACY_CFC_OPTIONS = {
  cfcEnforcementMode: "observe",
  cfcFlowLabels: "off",
  cfcWriteFloor: "off",
  cfcTriggerReadGating: false,
  cfcPolicyEvaluation: "off",
  cfcLabelMetadataProtection: "off",
  cfcDeclaredMonotonicity: "off",
} as const;
