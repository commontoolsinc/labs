import { normalize as normalizeResourcePath } from "@std/path/posix";
import type { HarnessAllowedSkillScript } from "../contracts/skill.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const normalizeSkillScriptPath = (path: string): string => {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("script path must be non-empty");
  }
  if (trimmed.includes("\0")) {
    throw new Error("script path must not contain null bytes");
  }
  const slashPath = trimmed.replaceAll("\\", "/");
  if (slashPath.startsWith("/")) {
    throw new Error("script path must be relative to the skill directory");
  }
  const normalized = normalizeResourcePath(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("script path must stay within the skill directory");
  }
  if (normalized === "scripts" || !normalized.startsWith("scripts/")) {
    throw new Error("script path must be under scripts/");
  }
  return normalized;
};

export const normalizeAllowedSkillScript = (
  input: HarnessAllowedSkillScript,
): HarnessAllowedSkillScript => {
  const skill = input.skill.trim();
  if (skill.length === 0) {
    throw new Error("skill name must be non-empty");
  }
  if (!SKILL_NAME_PATTERN.test(skill)) {
    throw new Error(
      `skill name should be lowercase alphanumeric with single hyphen separators: ${skill}`,
    );
  }
  return {
    skill,
    path: normalizeSkillScriptPath(input.path),
  };
};

export const parseAllowedSkillScriptSpec = (
  spec: string,
): HarnessAllowedSkillScript => {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(
      `allowed skill script must use skill:scripts/path form: ${spec}`,
    );
  }
  return normalizeAllowedSkillScript({
    skill: spec.slice(0, separator),
    path: spec.slice(separator + 1),
  });
};

export const allowedSkillScriptKey = (
  script: HarnessAllowedSkillScript,
): string => `${script.skill}:${script.path}`;

export const uniqueAllowedSkillScripts = (
  scripts: readonly HarnessAllowedSkillScript[],
): readonly HarnessAllowedSkillScript[] => {
  const seen = new Set<string>();
  const unique: HarnessAllowedSkillScript[] = [];
  for (const script of scripts) {
    const normalized = normalizeAllowedSkillScript(script);
    const key = allowedSkillScriptKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
};

export const isSkillScriptAllowlisted = (
  allowlist: readonly HarnessAllowedSkillScript[] | undefined,
  script: HarnessAllowedSkillScript,
): boolean => {
  if (allowlist === undefined || allowlist.length === 0) {
    return false;
  }
  const normalized = normalizeAllowedSkillScript(script);
  const key = allowedSkillScriptKey(normalized);
  return allowlist.some((allowed) =>
    allowedSkillScriptKey(normalizeAllowedSkillScript(allowed)) === key
  );
};
