/** The CFC posture used by piece tests that exercise pre-enforcement behavior. */
export const LEGACY_CFC_OPTIONS = {
  cfcEnforcementMode: "observe",
  cfcFlowLabels: "off",
  cfcWriteFloor: "off",
  cfcTriggerReadGating: false,
  cfcPolicyEvaluation: "off",
  cfcLabelMetadataProtection: "off",
  cfcDeclaredMonotonicity: "off",
} as const;
