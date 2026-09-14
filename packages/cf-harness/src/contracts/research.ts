import type { JSONSchema } from "@commonfabric/api";

import type { TrustedPatternRecord } from "./trusted-pattern.ts";

/** Discriminator for a persisted Common Fabric research run. */
export const HARNESS_RESEARCH_RUN_TYPE = "cf-harness.research-run" as const;

/** Whether the evidence was sufficient to hand the caller an actionable kit. */
export type HarnessResearchStatus = "complete" | "incomplete";

/** The implementation direction supported by the inspected evidence. */
export type HarnessResearchRecommendationKind =
  | "direct-run"
  | "compose"
  | "author"
  | "focused-api";

/** One exact range the research loop read from a trusted source. */
export interface HarnessResearchSourceRead {
  /** Stable id the final kit uses to cite this read. */
  sourceId: string;

  /** Which trusted source surface supplied the bytes. */
  kind: "documentation" | "pattern-metadata" | "pattern-source";

  /** Human-readable address of the document, record, or program file. */
  location: string;

  /** First character included in this read. */
  offset: number;

  /** Character position immediately after the last included character. */
  end: number;

  /** Total characters in the addressed section or file. */
  totalChars: number;

  /** SHA-256 digest of exactly the characters included in this read. */
  digest: string;

  /** Integrity classes carried by a documentation section. */
  integrity?: readonly string[];
}

/** Host-confirmed metadata for a pattern inspected during research. */
export interface HarnessResearchPatternRecord extends TrustedPatternRecord {
  /** Declared argument schema returned by the index. */
  argumentSchema?: JSONSchema;

  /** Declared result schema returned by the index. */
  resultSchema?: JSONSchema;

  /** Identity that published the record. */
  ownerDid?: string;

  /** Time the index recorded the pattern. */
  createdAt?: string;

  /** Program entry path, when source inspection succeeded. */
  main?: string;

  /** Program entry export, when the program declares one. */
  mainExport?: string;

  /** Authored source paths in the indexed program. */
  files?: readonly string[];

  /** Additional authored module roots folded into the program identity. */
  sourceRoots?: readonly string[];

  /** Files stored uninterpreted and folded into the program identity. */
  dataFiles?: readonly string[];

  /** Direct composition dependencies confirmed from record and source. */
  dependencies?: readonly string[];

  /** Whether the fetched source computes to {@link patternId}. */
  sourceIdentityVerified?: true;

  /** How the host established, or deferred, source identity verification. */
  identityVerification?: {
    /** Whether this process verified the identity or needs the full compiler. */
    status: "verified" | "deferred";

    /** Identity path used or required. */
    method: "light-entry-identity" | "full-fabric-compiler";

    /** Specific reason full-compiler verification is required. */
    detail?: string;
  };
}

/** One handle contract inspected without reading the value behind it. */
export interface HarnessResearchHandleRecord {
  /** General handle token the caller may pass to a pattern. */
  token: string;

  /** Safe shape-only description returned by `describe_handle`. */
  description: unknown;
}

/** One input the recommended implementation expects to receive. */
export interface HarnessResearchInputBinding {
  /** Argument name or role in the recommended pattern invocation. */
  name: string;

  /** Existing general handle token to bind there. */
  token: string;

  /** Why this handle fits the argument. */
  purpose: string;
}

/** A host-admitted rule and the exact reads that support it. */
export interface HarnessResearchRule {
  /** Concise implementation rule or API fact. */
  rule: string;

  /** Read ids supporting the rule. */
  sourceIds: readonly string[];
}

/** Practical invocation or complete source example for the recommendation. */
export interface HarnessResearchExample {
  /** Whether the content is tool input JSON or authored pattern source. */
  kind: "run-pattern-input" | "pattern-source";

  /** Complete example, never a clipped prefix. */
  content: string;

  /** Exact opened reads supporting every API used, comments included. */
  sourceIds: readonly string[];
}

/** Structured implementation guidance returned by the `research` tool. */
export interface HarnessResearchKit {
  /** Whether all required contracts and inputs were found. */
  status: HarnessResearchStatus;

  /** The task or focused follow-up this kit answers. */
  task: string;

  /** Concise evidence-backed implementation direction. */
  summary: string;

  /** Recommended reuse boundary. */
  recommendation: {
    /** Whether to run, compose, or author. */
    kind: HarnessResearchRecommendationKind;

    /** Why the inspected evidence supports that choice. */
    rationale: string;
  };

  /** Existing handles the recommendation consumes. */
  inputs: readonly HarnessResearchInputBinding[];

  /** Host-confirmed patterns selected for direct use or composition. */
  patterns: readonly HarnessResearchPatternRecord[];

  /** Ordered implementation instructions. */
  steps: readonly string[];

  /** Copyable invocation or complete source when the evidence supports one. */
  example?: HarnessResearchExample;

  /** API and authoring rules established by exact trusted reads. */
  rules: readonly HarnessResearchRule[];

  /** Checks the implementer should perform after applying the kit. */
  verification: readonly string[];

  /** Exact trusted reads the kit admitted. */
  sources: readonly HarnessResearchSourceRead[];

  /** Required evidence, input, or contract the loop could not establish. */
  missing: readonly string[];
}

/** Durable summary retained for resume, delegation, and authored provenance. */
export interface HarnessResearchRunSummary {
  /** Research-run discriminator. */
  type: typeof HARNESS_RESEARCH_RUN_TYPE;

  /** Unique id derived from the harness run and tool output. */
  researchRunId: string;

  /** Tool output that owns the full artifact record. */
  outputId: string;

  /** Structured implementation kit handed to the caller. */
  kit: HarnessResearchKit;

  /** Every pattern whose record the host confirmed during the run. */
  confirmedPatterns: readonly HarnessResearchPatternRecord[];

  /** Every safe handle description inspected during the run. */
  describedHandles: readonly HarnessResearchHandleRecord[];

  /** Time the host completed the research run. */
  completedAt: string;
}
