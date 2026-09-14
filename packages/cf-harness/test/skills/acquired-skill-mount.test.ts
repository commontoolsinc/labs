import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
} from "../../src/contracts/skill.ts";
import type { DockerRunscSandboxConfig } from "../../src/sandbox/types.ts";
import {
  acquiredSkillForHandle,
  sandboxConfigWithAcquiredSkill,
} from "../../src/skills/acquired-skill-mount.ts";

const REGISTRY_ID = "zubair-trabzada/ai-finance-claude/finance-budget";
const COMMIT_SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const OTHER_COMMIT_SHA = "0".repeat(40);

const acquisitionAt = (commitSha: string): HarnessSkillAcquisition => ({
  registryId: REGISTRY_ID,
  commitSha,
  sourceUrl: `https://skills.sh/${REGISTRY_ID}@${commitSha}/SKILL.md`,
  verification: "git-commit-sha",
  valueDigest: "sha256:instructions",
  receivedAt: "2026-09-14T00:00:00.000Z",
});

const acquiredAt = (commitSha: string): HarnessAcquiredSkill => ({
  registryId: REGISTRY_ID,
  commitSha,
  pin: `${REGISTRY_ID}@${commitSha}`,
  hostRoot: `/artifacts/run-1.acquired-skills/${commitSha}/finance-budget`,
  sandboxRoot: "/acquired-skill",
  scripts: [],
});

const parentSandbox: DockerRunscSandboxConfig = {
  dockerBinary: "docker",
  runtimeName: "runsc-cfc",
  image: "cf-harness:test",
  workspaceHostPath: "/tmp/workspace",
  workspaceMountPath: "/workspace",
  shellPath: "/bin/bash",
  dockerNetworkMode: "none",
  additionalMounts: [{
    kind: "host-bind",
    name: "docs",
    hostPath: "/tmp/docs",
    sandboxPath: "/docs",
    readOnly: true,
  }],
  extraDockerArgs: [],
};

describe("the acquired-skill mount a delegation gives its child", () => {
  //
  // The parent plans the acquisition and never holds its bytes; the child it
  // hands the handle to holds them, read-only, and holds no other skill's.
  //

  describe("acquiredSkillForHandle()", () => {
    it("returns the skill the handle's acquisition pins", () => {
      expect(
        acquiredSkillForHandle(
          [acquiredAt(OTHER_COMMIT_SHA), acquiredAt(COMMIT_SHA)],
          acquisitionAt(COMMIT_SHA),
        ),
      ).toEqual(acquiredAt(COMMIT_SHA));
    });

    it("returns nothing for the same skill acquired at another commit", () => {
      expect(
        acquiredSkillForHandle(
          [acquiredAt(OTHER_COMMIT_SHA)],
          acquisitionAt(COMMIT_SHA),
        ),
      ).toBeUndefined();
    });

    it("returns nothing for a handle no acquisition minted", () => {
      // An operator-seeded skill cell is handed over by handle with no
      // external source behind it, and mounts nothing.
      expect(acquiredSkillForHandle([acquiredAt(COMMIT_SHA)], undefined))
        .toBeUndefined();
    });
  });

  describe("sandboxConfigWithAcquiredSkill()", () => {
    it("adds one read-only mount of the acquired skill's host root", () => {
      const child = sandboxConfigWithAcquiredSkill(
        parentSandbox,
        acquiredAt(COMMIT_SHA),
      );

      expect(child?.additionalMounts).toEqual([
        ...parentSandbox.additionalMounts,
        {
          kind: "host-bind",
          name: "acquired-skill",
          hostPath: acquiredAt(COMMIT_SHA).hostRoot,
          sandboxPath: "/acquired-skill",
          readOnly: true,
        },
      ]);
    });

    it("leaves a child given no acquired skill with the parent's mounts", () => {
      // Which is also the parent's own case: nothing mounts an acquisition
      // into the run that made it.
      expect(sandboxConfigWithAcquiredSkill(parentSandbox, undefined))
        .toEqual(parentSandbox);
    });

    it("mounts nothing when the run has no sandbox configuration to extend", () => {
      expect(sandboxConfigWithAcquiredSkill(undefined, acquiredAt(COMMIT_SHA)))
        .toBeUndefined();
    });
  });
});
