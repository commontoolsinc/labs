export const HARNESS_SKILL_REGISTRY_TYPE = "cf-harness.skill-registry";
export const HARNESS_SKILL_ACTIVATIONS_TYPE = "cf-harness.skill-activations";
export const HARNESS_SKILL_RESOURCE_READS_TYPE =
  "cf-harness.skill-resource-reads";

export type HarnessSkillDiagnosticSeverity = "warning" | "error";

export interface HarnessSkillDiagnostic {
  severity: HarnessSkillDiagnosticSeverity;
  code: string;
  detail: string;
  path?: string;
}

export type HarnessSkillFrontmatterValue =
  | string
  | boolean
  | readonly string[];

export type HarnessSkillResourceKind =
  | "reference"
  | "asset"
  | "template"
  | "script"
  | "other";

export type HarnessSkillResourceContentKind = "text" | "binary";

export type HarnessSkillCfcPromptRole = "context";

export interface HarnessSkillResourceRecord {
  path: string;
  kind: HarnessSkillResourceKind;
  resourcePath: string;
  sandboxResourcePath: string;
  sizeBytes: number;
  digest: string;
  contentKind: HarnessSkillResourceContentKind;
  diagnostics: HarnessSkillDiagnostic[];
}

export type HarnessSkillResourceReadStatus = "read" | "binary" | "error";

export type HarnessSkillResourceReadErrorCode =
  | "skill_registry_missing"
  | "skill_not_found"
  | "resource_path_invalid"
  | "resource_not_indexed"
  | "resource_not_found"
  | "resource_not_file"
  | "resource_outside_root"
  | "permission_denied"
  | "unknown";

export interface HarnessSkillResourceReadError {
  code: HarnessSkillResourceReadErrorCode;
  message: string;
}

export interface HarnessSkillResourceRead {
  type: "cf-harness.skill-resource-read";
  outputId: string;
  runId: string;
  skillName: string;
  path: string;
  status: HarnessSkillResourceReadStatus;
  readAt: string;
  cfcPromptRole: HarnessSkillCfcPromptRole;
  kind?: HarnessSkillResourceKind;
  resourcePath?: string;
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;
  contentKind?: HarnessSkillResourceContentKind;
  maxBytes?: number;
  truncated?: boolean;
  diagnostics: HarnessSkillDiagnostic[];
  error?: HarnessSkillResourceReadError;
}

export interface HarnessSkillResourceReads {
  type: typeof HARNESS_SKILL_RESOURCE_READS_TYPE;
  version: 1;
  generatedAt: string;
  reads: HarnessSkillResourceRead[];
}

export interface HarnessSkillRecord {
  name: string;
  description: string;
  skillPath: string;
  skillDir: string;
  sandboxSkillPath: string;
  sandboxSkillDir: string;
  digest: string;
  resources: HarnessSkillResourceRecord[];
  frontmatter: Record<string, HarnessSkillFrontmatterValue>;
  diagnostics: HarnessSkillDiagnostic[];
}

export interface HarnessSkillRegistry {
  type: typeof HARNESS_SKILL_REGISTRY_TYPE;
  version: 1;
  skillsRoot: string;
  sandboxSkillsRoot: string;
  generatedAt: string;
  skills: HarnessSkillRecord[];
  diagnostics: HarnessSkillDiagnostic[];
}

export type HarnessSkillActivationSource =
  | "cli-preload"
  | "model-tool"
  | "user-explicit"
  | "subagent-inherit";

export interface HarnessSkillActivation {
  name: string;
  source: HarnessSkillActivationSource;
  runId: string;
  skillPath: string;
  skillDir: string;
  sandboxSkillPath: string;
  sandboxSkillDir: string;
  digest: string;
  activatedAt: string;
  cfcPromptRole: HarnessSkillCfcPromptRole;
}

export interface HarnessSkillActivations {
  type: typeof HARNESS_SKILL_ACTIVATIONS_TYPE;
  version: 1;
  generatedAt: string;
  activations: HarnessSkillActivation[];
}
