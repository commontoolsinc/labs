import { join, normalize } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createHarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
  HarnessSkillActivations,
  HarnessSkillScriptExecution,
} from "../../src/contracts/skill.ts";
import type { ProcessRunner } from "../../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../../src/sandbox/types.ts";
import { runSkillScriptTool } from "../../src/tools/run-skill-script.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";

const REGISTRY_ID = "zubair-trabzada/ai-finance-claude/finance-budget";
const COMMIT_SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const PIN = `${REGISTRY_ID}@${COMMIT_SHA}`;
const SCRIPT_PATH = "scripts/report.sh";
const SCRIPT_TEXT = "#!/usr/bin/env bash\necho acquired\n";
const SANDBOX_ROOT = "/acquired-skill";

const digestText = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
      .join("")
  }`;
};

class RecordingSandboxRuntime implements SandboxRuntime {
  readonly calls: SandboxCommandRequest[] = [];

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.calls.push(request);
    return Promise.resolve({ stdout: "acquired\n", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    throw new Error("the acquired-script path does not use the sandbox shell");
  }
}

const unusedProcessRunner: ProcessRunner = {
  run() {
    throw new Error("the acquired-script path does not run host processes");
  },
};

const acquisition = (): HarnessSkillAcquisition => ({
  registryId: REGISTRY_ID,
  commitSha: COMMIT_SHA,
  sourceUrl: `https://skills.sh/${REGISTRY_ID}@${COMMIT_SHA}/SKILL.md`,
  verification: "git-commit-sha",
  valueDigest: "sha256:instructions",
  receivedAt: "2026-09-14T00:00:00.000Z",
});

const activationsHoldingTheAcquiredSkill = (): HarnessSkillActivations => ({
  type: "cf-harness.skill-activations",
  version: 1,
  generatedAt: "2026-09-14T00:00:00.000Z",
  activations: [{
    name: "handle:cfh:a:f4ecd",
    source: "skill-handle",
    runId: "run-1",
    digest: "sha256:instructions",
    activatedAt: "2026-09-14T00:00:00.000Z",
    cfcPromptRole: "context",
    handleToken: "cfh:a:f4ecd",
    acquisition: acquisition(),
  }],
});

interface ContextOptions {
  sandbox: SandboxRuntime;
  executions: HarnessSkillScriptExecution[];
  acquiredSkills?: readonly HarnessAcquiredSkill[];
  skillActivations?: HarnessSkillActivations;
  allowedSkillScripts?: readonly { skill: string; path: string }[];
}

const createContext = (options: ContextOptions): HarnessToolContext => {
  let sequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode: "observe",
    workspaceHostPath: "/tmp/cf-harness-workspace",
    skillActivations: options.skillActivations,
    allowedSkillScripts: options.allowedSkillScripts,
    acquiredSkills: options.acquiredSkills,
    skillScriptExecutionTarget: "sandbox",
    currentDir: "/workspace",
    sandbox: options.sandbox,
    hostProcessRunner: unusedProcessRunner,
    resolvePath: (path) => options.sandbox.resolvePath(path, "/workspace"),
    resolveHostPath: (path) => `/tmp/cf-harness-workspace${path}`,
    resolveHostRootPath: () => "/tmp/cf-harness-workspace",
    hostPathToWorkspacePath: () => undefined,
    describeHostMountCovering: () => undefined,
    isHostPathWithinWorkspace: () => Promise.resolve(true),
    isHostPathWithinArtifactRoot: () => Promise.resolve(false),
    doesHostPathIntersectArtifactRoot: () => Promise.resolve(false),
    setCurrentDir: () => {},
    nextOutputId(toolId) {
      sequence += 1;
      return createToolOutputId("run-1", toolId, sequence);
    },
    now: () => "2026-09-14T00:00:00.000Z",
    recordSkillResourceRead: () => Promise.resolve(),
    recordSkillScriptExecution(execution) {
      options.executions.push(execution);
      return Promise.resolve();
    },
    createCfcInvocationContext: (invocation) =>
      Promise.resolve(createHarnessCfcInvocationContext({
        sequence: 1,
        runId: "run-1",
        createdAt: "2026-09-14T00:00:00.000Z",
        cfcEnforcementMode: "observe",
        runManifest: { present: false },
        ...invocation,
      })),
  };
};

describe("run_skill_script on an acquired skill's script", () => {
  //
  // An acquired skill has no registry name, no registry directory and no
  // run-start snapshot. What it has is the pin its bytes were read at, and
  // every gate a registry script passes is asked of the pin instead: the
  // operator's allowlist keys on it, the activation is found by it, and the
  // digest the file is re-checked against is the one taken when those bytes
  // arrived.
  //

  let hostRoot: string;
  let scriptDigest: string;
  let executions: HarnessSkillScriptExecution[];
  let sandbox: RecordingSandboxRuntime;

  const acquiredSkill = (): HarnessAcquiredSkill => ({
    registryId: REGISTRY_ID,
    commitSha: COMMIT_SHA,
    pin: PIN,
    hostRoot,
    sandboxRoot: SANDBOX_ROOT,
    scripts: [{
      path: SCRIPT_PATH,
      hostPath: join(hostRoot, SCRIPT_PATH),
      sandboxPath: `${SANDBOX_ROOT}/${SCRIPT_PATH}`,
      valueDigest: scriptDigest,
      sizeBytes: new TextEncoder().encode(SCRIPT_TEXT).byteLength,
    }],
  });

  beforeEach(async () => {
    hostRoot = await Deno.makeTempDir({ prefix: "cf-harness-acquired-" });
    await Deno.mkdir(join(hostRoot, "scripts"), { recursive: true });
    await Deno.writeTextFile(join(hostRoot, SCRIPT_PATH), SCRIPT_TEXT);
    scriptDigest = await digestText(SCRIPT_TEXT);
    executions = [];
    sandbox = new RecordingSandboxRuntime();
  });

  afterEach(async () => {
    await Deno.remove(hostRoot, { recursive: true });
  });

  it("runs the script the pin names, from the mount the child holds", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("executed");
    expect(output.runtime).toBe("shebang");
    expect(output.argv).toEqual(["bash", "-s", "--"]);
    expect(output.stdout).toBe("acquired\n");
    expect(output.sandboxResourcePath).toBe(`${SANDBOX_ROOT}/${SCRIPT_PATH}`);
    expect(sandbox.calls.length).toBe(1);
    expect(sandbox.calls[0]?.stdinText).toBe(SCRIPT_TEXT);
    expect(sandbox.calls[0]?.env).toEqual({
      CF_HARNESS_RUN_ID: "run-1",
      SKILL_NAME: PIN,
      SKILL_DIR: SANDBOX_ROOT,
      SKILL_SCRIPT: `${SANDBOX_ROOT}/${SCRIPT_PATH}`,
      CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: "sandbox",
    });
  });

  it("refuses a pin this run acquired nothing at", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("skill_not_found");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses when no activation names the pin, however the allowlist reads", async () => {
    // Activation is what says this run was GIVEN the skill. A run that holds
    // the bytes on disk but was handed no handle to them has not been given
    // it, so a registry-shaped activation of some other name does not count.
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: {
          type: "cf-harness.skill-activations",
          version: 1,
          generatedAt: "2026-09-14T00:00:00.000Z",
          activations: [{
            name: "pattern-dev",
            source: "cli-preload",
            runId: "run-1",
            digest: "sha256:other",
            activatedAt: "2026-09-14T00:00:00.000Z",
            cfcPromptRole: "context",
          }],
        },
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("skill_not_activated");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a script the operator allowlisted at another commit", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{
          skill: `${REGISTRY_ID}@${"0".repeat(40)}`,
          path: SCRIPT_PATH,
        }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_not_allowlisted");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a file the host changed after acquisition", async () => {
    await Deno.writeTextFile(
      join(hostRoot, SCRIPT_PATH),
      "#!/usr/bin/env bash\necho tampered\n",
    );

    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_snapshot_mismatch");
    expect(output.error?.message).toContain("acquired at this pin");
    expect(output.observedDigest).not.toBe(scriptDigest);
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a script whose real path leaves the acquired skill's directory", async () => {
    // Containment is checked against the acquired root, which is the only
    // directory the child mounts. A link out of it names bytes no acquisition
    // fetched, whatever they digest to.
    const outside = await Deno.makeTempDir({ prefix: "cf-harness-outside-" });
    try {
      const escape = join(outside, "report.sh");
      await Deno.writeTextFile(escape, SCRIPT_TEXT);
      await Deno.remove(join(hostRoot, SCRIPT_PATH));
      await Deno.symlink(escape, join(hostRoot, SCRIPT_PATH));

      const output = await runSkillScriptTool.invoke(
        createContext({
          sandbox,
          executions,
          acquiredSkills: [acquiredSkill()],
          skillActivations: activationsHoldingTheAcquiredSkill(),
          allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
        }),
        { skill: PIN, path: SCRIPT_PATH },
      );

      expect(output.status).toBe("error");
      expect(output.error?.code).toBe("script_outside_root");
      expect(sandbox.calls.length).toBe(0);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("records the acquisition and no registry provenance", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.acquisition).toEqual(acquisition());
    expect(output.observedDigest).toBe(scriptDigest);
    expect(output.registryDigest).toBeUndefined();
    expect(output.registrySizeBytes).toBeUndefined();
    expect(output.digestMatchesRegistry).toBeUndefined();

    expect(executions.length).toBe(1);
    const record = executions[0]!;
    expect(record.skillName).toBe(PIN);
    expect(record.acquisition?.registryId).toBe(REGISTRY_ID);
    expect(record.acquisition?.commitSha).toBe(COMMIT_SHA);
    expect(record.observedDigest).toBe(scriptDigest);
    expect(record.registryDigest).toBeUndefined();
    expect(record.registrySizeBytes).toBeUndefined();
    expect(record.digestMatchesRegistry).toBeUndefined();
    expect(record.resourcePath).toBe(join(hostRoot, SCRIPT_PATH));
  });

  it("labels the invocation with confidentiality alone, never the acquisition's integrity", async () => {
    // CT-2302: a non-empty `integrity` array in `cfcInputLabels` makes the
    // sandbox fail to start, so the acquisition's ExternalIngest atom cannot
    // ride the invocation. It rides the output instead.
    await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    const labels = sandbox.calls[0]?.cfcInvocationContext?.cfcInputLabels;
    const integrityAtoms = (labels?.entries ?? []).flatMap((entry) =>
      entry.label.integrity ?? []
    );
    expect(integrityAtoms).toEqual([]);
  });
});
