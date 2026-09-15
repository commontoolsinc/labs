/**
 * The operator's skill-script allowlist as the console receives it: the
 * `skill:scripts/path` specs a launch names, and the one variable they travel
 * to the server in.
 *
 * Which script a run may execute is a decision nothing about the fabric
 * implies, so it arrives as an operator's entry rather than being derived.
 * The launcher and the server both take one, and both turn it into the same
 * normalized allowlist here, so an entry that is accepted at launch is the
 * entry a run compares a call against.
 */

import type { HarnessAllowedSkillScript } from "../src/contracts/skill.ts";
import {
  parseAcquiredSkillPin,
  parseAllowedSkillScriptSpec,
  uniqueAllowedSkillScripts,
} from "../src/skills/scripts.ts";

/** The variable a launch hands its resolved allowlist to the server in. */
export const ALLOWED_SKILL_SCRIPTS_VARIABLE =
  "CF_HARNESS_ALLOWED_SKILL_SCRIPTS";

/**
 * The specs `ALLOWED_SKILL_SCRIPTS_VARIABLE` carries, which is a JSON array of
 * them.
 *
 * One variable holds a list, and a spec admits every character a delimited
 * encoding could separate on — a discovery slug may hold a colon, a script
 * path anything a path holds — so the value is JSON rather than a delimiter
 * an entry could contain.
 */
export const parseAllowedSkillScriptsVariable = (
  value: string,
): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `\`${ALLOWED_SKILL_SCRIPTS_VARIABLE}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `\`${ALLOWED_SKILL_SCRIPTS_VARIABLE}\` must hold an array of ` +
        `\`skill:scripts/path\` strings`,
    );
  }
  return parsed as readonly string[];
};

/**
 * The allowlist `specs` describes, with each entry normalized and the
 * duplicates dropped.
 *
 * Throws naming `holder` — the flag, variable or constant the specs came from —
 * and the entry, whenever a spec is not one an allowlist can key on. Such a
 * spec reaching a run is an entry that matches no call: the run refuses every
 * script the operator meant to allow, and says only that it was not
 * allowlisted.
 */
export const resolveAllowedSkillScripts = (
  specs: readonly string[],
  holder: string,
): readonly HarnessAllowedSkillScript[] => {
  const parsed = specs.map((spec) => {
    try {
      return parseAllowedSkillScriptSpec(spec);
    } catch (error) {
      throw new Error(
        `\`${holder}\` entry \`${spec}\` is not a script an allowlist can ` +
          `name: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return uniqueAllowedSkillScripts(parsed);
};

/**
 * Throws when an entry could not address the script it names.
 *
 * A REGISTRY entry names its script by the sandbox path a configured skills
 * tree gives it, so without one the entry addresses nothing and every call it
 * was written to allow is refused as un-allowlisted. A checkout fallback does
 * not count: it is read on the host and carries no sandbox mapping, which is
 * why `skillsRootConfigured` asks whether an operator named a tree rather than
 * whether one was resolved. An acquired pin is exempt throughout: its bytes
 * reach the sandbox through the acquisition's own mount, which no skills root
 * takes part in.
 */
export const assertAllowedSkillScriptsAddressable = (
  scripts: readonly HarnessAllowedSkillScript[],
  skillsRootConfigured: boolean,
): void => {
  if (skillsRootConfigured) {
    return;
  }
  const unaddressable = scripts.find((script) =>
    parseAcquiredSkillPin(script.skill) === undefined
  );
  if (unaddressable !== undefined) {
    throw new Error(
      `\`${unaddressable.skill}\` is a registry skill, whose script is ` +
        `addressed by the path a configured skills tree gives it, and this ` +
        `console was given none — a checkout's own tree is read on the host ` +
        `and carries no sandbox mapping: set \`--skills-root\` or ` +
        `\`CF_HARNESS_CONSOLE_SKILLS_ROOT\`, or key the entry on an ` +
        `acquired pin`,
    );
  }
};
