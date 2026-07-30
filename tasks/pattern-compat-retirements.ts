import type { BaselineRetirement } from "./pattern-compat-lib.ts";

/**
 * Exact historical contracts deliberately excluded from rollout proofs.
 *
 * Never delete the corresponding baseline JSON. A retirement is permitted
 * only after the stored population has been migrated, expired, or explicitly
 * approved for a wipe, with the decision recorded in live documentation.
 */
export const PATTERN_BASELINE_RETIREMENTS: readonly BaselineRetirement[] = [
  {
    pattern: "examples/array-in-cell-with-remove-editable.tsx",
    baseline: "20260729T022742Z--kRTqpCBkByWzcff",
    reason:
      "Pre-launch Factory@1 handler migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "google/core/experimental/gmail-agentic-search.tsx",
    baseline: "20260729T022742Z-dZgG8iv9TdVC9NpM",
    reason:
      "Pre-launch Factory@1 handler migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "lobby/main.tsx",
    baseline: "20260729T022742Z-GhLFnf8OCmke_Jje",
    reason:
      "Pre-launch FactoryInput normalization changed the trusted writer identity; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "notes/note.tsx",
    baseline: "20260729T022742Z-6XD3xNCqAXQG3JgM",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/common-fabric.tsx",
    baseline: "20260729T022742Z-33-wy7gTBm_BLP4I",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/suggestion-history.tsx",
    baseline: "20260729T022742Z-IsxNGAP5BITr9Pv1",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/summary-index.tsx",
    baseline: "20260729T022742Z-_lCRVDAIzW-JJzkF",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
];
