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

import type {
  DockerRunscSandboxConfig,
  SandboxRuntime,
} from "../sandbox/types.ts";
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
 * The refusal a run meets when a mount of its own sandbox covers the directory
 * its acquired scripts would be written into.
 *
 * A class rather than a message, because the caller has to tell this apart
 * from a failure to write: this one is a policy answer about who could read
 * the bytes, and the tool reports it as a refusal naming the mount, while a
 * disk that would not take the file is an error.
 */
export class AcquiredSkillDirectoryReadableError extends Error {
  static readonly code = "acquired_scripts_readable_by_acquiring_run";

  constructor(message: string) {
    super(message);
    this.name = "AcquiredSkillDirectoryReadableError";
  }
}

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
 * The sandbox options a child engine is built with, given the acquired skill
 * it was handed.
 *
 * A child normally shares its parent's sandbox runtime — the same container
 * configuration, and the object that executes in it. A child that mounts an
 * acquired skill cannot: the mount is a property of the container, so a
 * runtime already built against the parent's mounts would ignore any
 * configuration handed alongside it and the skill's directory would never
 * appear. Such a child is given a configuration and no runtime, and builds its
 * own from it — which also keeps the CFC transport floor, since an engine
 * checks that only for a sandbox it built.
 *
 * The parent's own configuration is what is extended, so the child differs
 * from it in exactly one mount: the acquired skill's host root, read-only,
 * because a script the child could rewrite is a script whose acquisition
 * digest says nothing about what ran. Where the parent's runtime was handed in
 * rather than built, there is no configuration to extend and the child shares,
 * acquired skill or not.
 */
export const childSandboxOptions = (
  parent: {
    sandbox: SandboxRuntime;
    ownedSandboxConfig?: DockerRunscSandboxConfig;
    configuredSandbox?: DockerRunscSandboxConfig;
  },
  acquired: HarnessAcquiredSkill | undefined,
): {
  sandboxRuntime?: SandboxRuntime;
  sandbox?: DockerRunscSandboxConfig;
} => {
  if (acquired === undefined || parent.ownedSandboxConfig === undefined) {
    return {
      sandboxRuntime: parent.sandbox,
      ...(parent.configuredSandbox !== undefined
        ? { sandbox: parent.configuredSandbox }
        : {}),
    };
  }
  return {
    sandbox: {
      ...parent.ownedSandboxConfig,
      additionalMounts: [
        ...parent.ownedSandboxConfig.additionalMounts,
        {
          kind: "host-bind",
          name: ACQUIRED_SKILL_MOUNT_NAME,
          hostPath: acquired.hostRoot,
          sandboxPath: acquired.sandboxRoot,
          readOnly: true,
        },
      ],
    },
  };
};
