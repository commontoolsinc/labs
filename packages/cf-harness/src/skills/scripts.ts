import { normalize as normalizeResourcePath } from "@std/path/posix";
import type { HarnessAllowedSkillScript } from "../contracts/skill.ts";
import { parseSkillsShSkillId } from "../skills-sh/pin.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A full lowercase Git commit SHA, which is the whole of an acquired pin. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Whether `skill` names an acquired skill rather than a registry one: a
 * discovery id and the commit its bytes were read at, joined by `@`.
 *
 * An acquired skill has no registry name to key an allowlist entry on, and the
 * pin is what it has instead — it names the exact bytes, which is more than a
 * name does. Both forms go through one key, one uniqueness rule and one
 * membership test, because what the operator is deciding is the same thing.
 */
const acquiredSkillPin = (
  skill: string,
): { readonly id: string; readonly commitSha: string } | undefined => {
  const at = skill.lastIndexOf("@");
  if (at <= 0) return undefined;
  const id = skill.slice(0, at);
  const commitSha = skill.slice(at + 1);
  if (!COMMIT_SHA_PATTERN.test(commitSha)) return undefined;
  try {
    parseSkillsShSkillId(id);
  } catch {
    return undefined;
  }
  return { id, commitSha };
};

/**
 * Whether `skill` is a name this allowlist may key on: a registry skill's
 * name, or an acquired skill's pin.
 */
export const isAllowedSkillScriptSkill = (skill: string): boolean =>
  SKILL_NAME_PATTERN.test(skill) || acquiredSkillPin(skill) !== undefined;

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
  if (!isAllowedSkillScriptSkill(skill)) {
    throw new Error(
      `skill should be a registry name — lowercase alphanumeric with single hyphen separators — or an acquired pin, owner/repo/slug@<commit sha>: ${skill}`,
    );
  }
  return {
    skill,
    path: normalizeSkillScriptPath(input.path),
  };
};

/**
 * The `skill:scripts/path` form an operator writes, where `skill` is a
 * registry name or an acquired pin.
 *
 * Split on the FIRST colon, which neither a registry name, a discovery id nor
 * a commit SHA may contain — so widening the skill field did not move where
 * this separator is.
 */
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
