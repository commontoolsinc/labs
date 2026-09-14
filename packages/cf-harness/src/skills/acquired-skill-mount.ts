import type {
  DockerRunscSandboxConfig,
  SandboxRuntimeMountKind,
} from "../sandbox/types.ts";
import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
} from "../contracts/skill.ts";

/** The mount name a child's acquired-skill directory is bound under. */
export const ACQUIRED_SKILL_MOUNT_NAME = "acquired-skill";

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
        kind: "host-bind" satisfies SandboxRuntimeMountKind,
        name: ACQUIRED_SKILL_MOUNT_NAME,
        hostPath: acquired.hostRoot,
        sandboxPath: acquired.sandboxRoot,
        readOnly: true,
      },
    ],
  };
};
