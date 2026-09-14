/**
 * How an acquired skill's scripts reach the one run allowed to execute them.
 *
 * Acquisition happens in a parent and execution in a child, and the whole of
 * the arrangement between them is here: which acquired skill a delegation's
 * `skillHandle` selects, and what the child's sandbox configuration becomes
 * once it has one. The parent that planned an acquisition never mounts its
 * bytes; the child it hands the handle to mounts that skill's and no other's,
 * read-only.
 */

import type { DockerRunscSandboxConfig } from "../sandbox/types.ts";
import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
} from "../contracts/skill.ts";

/** The mount name a child's acquired-skill directory is bound under. */
export const ACQUIRED_SKILL_MOUNT_NAME = "acquired-skill";

/**
 * Where a run that holds a skill's handle sees that skill's acquired scripts.
 *
 * One path rather than one per pin: a delegation carries a single
 * `skillHandle`, so a child has one acquired skill and needs one mount, and a
 * fixed path is what the `sandboxPath` recorded at acquisition can be written
 * against — before any child exists to be told where its mount landed.
 */
export const ACQUIRED_SKILL_MOUNT_PATH = "/acquired-skill";

/**
 * The acquired skill a delegation hands its child: the one the acquisition
 * behind the delegation's `skillHandle` names, and no other.
 *
 * A run holds the scripts of the skill it was given. The pin is the match —
 * the discovery id and the commit together — because two acquisitions of one
 * skill at two commits are two different sets of bytes, and a child given the
 * handle to one must not reach the other.
 */
export const acquiredSkillForHandle = (
  acquiredSkills: readonly HarnessAcquiredSkill[] | undefined,
  acquisition: HarnessSkillAcquisition | undefined,
): HarnessAcquiredSkill | undefined =>
  acquisition === undefined
    ? undefined
    : acquiredSkills?.find((skill) =>
      skill.registryId === acquisition.registryId &&
      skill.commitSha === acquisition.commitSha
    );

/**
 * A child's sandbox configuration, with the one acquired skill it was given
 * mounted read-only.
 *
 * The mount goes into this child's sandbox and never the parent's, which is
 * why the directory sits outside every mount the parent holds to begin with:
 * the parent that planned the acquisition still cannot read the bytes it
 * acquired, and that is the property the hostile-skill receipt rests on.
 *
 * Read-only because a script the child could rewrite is a script whose
 * acquisition digest says nothing about what ran.
 *
 * Returns the configuration unchanged when the child was given no acquired
 * skill, and `undefined` when the parent has no sandbox configuration to
 * extend — a run whose sandbox runtime came from elsewhere mounts nothing
 * through this path.
 */
export const sandboxConfigWithAcquiredSkill = (
  sandbox: DockerRunscSandboxConfig | undefined,
  acquired: HarnessAcquiredSkill | undefined,
): DockerRunscSandboxConfig | undefined => {
  if (sandbox === undefined || acquired === undefined) {
    return sandbox;
  }
  return {
    ...sandbox,
    additionalMounts: [
      ...sandbox.additionalMounts,
      {
        kind: "host-bind",
        name: ACQUIRED_SKILL_MOUNT_NAME,
        hostPath: acquired.hostRoot,
        sandboxPath: acquired.sandboxRoot,
        readOnly: true,
      },
    ],
  };
};
