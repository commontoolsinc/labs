export const HARNESS_SKILL_REGISTRY_TYPE = "cf-harness.skill-registry";
export const HARNESS_SKILL_ACTIVATIONS_TYPE = "cf-harness.skill-activations";

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

export type HarnessSkillCfcPromptRole = "context";

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
