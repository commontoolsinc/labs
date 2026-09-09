/**
 * Two conditions the run family's output directory rests on, neither of them
 * about the tool that reads from it: that the directory exists before any
 * child goes looking for it, and that the sidecar carrying the evidence its
 * contents are labelled from is somewhere the sandbox cannot write.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runCfHarnessCli } from "../src/cli.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";
import {
  familyDirBesideWorkspace,
  familyDirUnderArtifactRoot,
  sandboxOutputRootHostPath,
} from "../src/sandbox/output-root.ts";
import { forgetWorkspaceTaintForTesting } from "../src/workspace-taint.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class SilentSandbox implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string): string {
    return path;
  }
  isPathWithinWorkspace(path: string): boolean {
    return path.startsWith("/workspace");
  }
  isPathWithinAllowedRoots(path: string): boolean {
    return path.startsWith("/workspace");
  }
  defaultWorkingDirectory(): string {
    return "/workspace";
  }
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("the run family's output directory", () => {
  it("exists before the loop dispatches anything", async () => {
    // A run whose first tool call is `delegate_task` never reaches
    // `invokeBuiltinTool`, because the prompt loop special-cases delegation.
    // A root established only there would be missing exactly when a child
    // went looking for it.
    //
    // Driven with a signal that is already aborted, so what the assertion
    // turns on is the ordering alone: the directory is there even though the
    // loop never got as far as a turn, let alone a tool call. Aborted rather
    // than failing, so the loop stops on an event rather than on a retry
    // schedule running out.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-root-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `output-root-${crypto.randomUUID()}`;
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new SilentSandbox(),
        runId,
        model: "gpt-5.4",
        workspaceHostPath: workspace,
        artifactRoot,
      });
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: () => Promise.reject(new Error("model never reached")),
      });

      await expect(
        loop.runPrompt({ prompt: "Say hi.", signal: AbortSignal.abort() }),
      ).rejects.toThrow();

      const root = sandboxOutputRootHostPath(
        familyDirUnderArtifactRoot(artifactRoot, runId),
      );
      expect((await Deno.stat(root)).isDirectory).toBe(true);
      expect(engine.getRunState().sandboxOutputRoot?.hostPath).toBe(root);
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("is the same directory a delegated child writes into", async () => {
    // The child keys by the root run's id, so it joins the family's directory
    // rather than making one of its own — and finds it already there.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-root-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `output-root-${crypto.randomUUID()}`;
    try {
      const parent = new CfHarnessEngine({
        sandboxRuntime: new SilentSandbox(),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
      });
      await parent.ensureSandboxOutputRoot();

      const child = new CfHarnessEngine({
        sandboxRuntime: new SilentSandbox(),
        runId: `${runId}.subagent.1`,
        lineage: {
          role: "subagent",
          rootRunId: runId,
          parentRunId: runId,
          parentToolCallId: "call-1",
          depth: 1,
        },
        workspaceHostPath: workspace,
        artifactRoot,
      });
      await child.ensureSandboxOutputRoot();

      expect(child.getRunState().sandboxOutputRoot?.hostPath).toBe(
        sandboxOutputRootHostPath(
          familyDirUnderArtifactRoot(artifactRoot, runId),
        ),
      );
      expect(child.sandboxOutputRootFailure).toBeUndefined();
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});

describe("CFC sidecar transport isolation", () => {
  // The harness writes the invocation context a container starts tainted
  // from, and reads back the final taint a cell's label is minted from.
  // Neither claim survives the directory being writable by the workload it
  // describes: a container that can rewrite its own result sidecar names its
  // own taint.

  it("refuses a result directory inside the workspace mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          cfcResultDir: join(workspace, "sidecars", "results"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("refuses an invocation-context directory inside a writable extra mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const extra = await Deno.makeTempDir({ prefix: "cf-harness-iso-mount-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          additionalMounts: [{
            kind: "host-bind",
            name: "data",
            hostPath: extra,
            sandboxPath: "/data",
            readOnly: false,
          }],
          cfcInvocationContextDir: join(extra, "invocation-context"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(extra, { recursive: true });
    }
  });

  it("refuses a result directory whose parent does not exist yet", async () => {
    // These directories are created on first write, so the usual case is that
    // neither the directory nor its parent is there when the config resolves.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          cfcResultDir: join(workspace, "not", "yet", "made"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("admits a transport directory under a root that does not exist", async () => {
    // Nothing to resolve on either side, so the literal path is all there is
    // to compare — and a directory whose ancestors are absent is inside no
    // mount that exists.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    try {
      const config = resolveDockerRunscSandboxConfig({
        workspaceHostPath: workspace,
        cfcResultDir: "/cf-harness-absent-root/sidecars/results",
      });

      expect(config.cfcResultDir).toBe(
        "/cf-harness-absent-root/sidecars/results",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  });

  it("refuses an empty --cfc-result-dir", async () => {
    const errors: string[] = [];
    const exitCode = await runCfHarnessCli(
      ["--prompt", "hi", "--cfc-result-dir", "  "],
      { io: { stdout: () => {}, stderr: (line: string) => errors.push(line) } },
    );

    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("requires a non-empty path");
  });

  it("refuses a result directory inside the run's output mount", async () => {
    // The output directory is bound read-write into the sandbox, so a
    // transport directory there is one the workload can rewrite — and it
    // carries the evidence that directory's contents are labelled from.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    try {
      const outputRoot = sandboxOutputRootHostPath(
        familyDirUnderArtifactRoot(artifactRoot, "family-1"),
      );
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          additionalMounts: [{
            kind: "host-bind",
            name: "cf-harness-out",
            hostPath: outputRoot,
            sandboxPath: "/cf-harness/out",
            readOnly: false,
          }],
          cfcResultDir: join(outputRoot, "sidecars"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("refuses an invocation-context directory inside the artifact root", async () => {
    // Not a mount, but it holds the record a run writes about itself; the
    // evidence that record is labelled from does not belong there.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          artifactRootHostPath: artifactRoot,
          cfcInvocationContextDir: join(artifactRoot, "invocation-context"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("admits a transport directory outside every writable mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-iso-" });
    const sidecars = await Deno.makeTempDir({ prefix: "cf-harness-iso-side-" });
    try {
      const config = resolveDockerRunscSandboxConfig({
        workspaceHostPath: workspace,
        cfcResultDir: sidecars,
      });

      expect(config.cfcResultDir).toBe(sidecars);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(sidecars, { recursive: true });
    }
  });

  it("refuses a relative result directory from the environment", () => {
    // The flag is validated at the CLI, but the environment fallback reaches
    // the resolver directly — and everything below it walks the path apart,
    // which a relative path has no root to walk to.

    const previous = Deno.env.get("CF_HARNESS_RUNSC_CFC_RESULT_DIR");
    Deno.env.set("CF_HARNESS_RUNSC_CFC_RESULT_DIR", "sidecars/results");
    try {
      expect(() =>
        resolveDockerRunscSandboxConfig({ workspaceHostPath: "/host/project" })
      )
        .toThrow(/cfcResultDir must be an absolute host path/);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("CF_HARNESS_RUNSC_CFC_RESULT_DIR");
      } else {
        Deno.env.set("CF_HARNESS_RUNSC_CFC_RESULT_DIR", previous);
      }
    }
  });

  it("refuses a relative result directory passed to the resolver directly", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir: "sidecars/results",
      })
    ).toThrow(/cfcResultDir must be an absolute host path/);
  });

  it("refuses a relative --cfc-result-dir rather than resolving it", async () => {
    // Resolving against the working directory is how one lands inside the
    // workspace, since the workspace defaults to that same directory.
    const errors: string[] = [];
    const exitCode = await runCfHarnessCli(
      ["--prompt", "hi", "--cfc-result-dir", "sidecars/results"],
      {
        io: {
          stdout: () => {},
          stderr: (line: string) => errors.push(line),
        },
      },
    );

    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain("requires an absolute path");
  });
});

describe("where the run family's output directory is placed", () => {
  // The mount's SOURCE has to be somewhere the sandbox cannot reach by
  // another route. Mounting a directory twice does not stop the workload
  // writing it through the first mount.

  it("keeps it out of the workspace when the artifact root is inside one", async () => {
    // The CLI's default: the artifact root sits under the working directory,
    // which is also the default workspace. That is the ordinary
    // configuration, and the one the artifact root cannot serve.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-place-" });
    const artifactRoot = join(workspace, "artifacts");
    const runId = `place-${crypto.randomUUID()}`;
    try {
      await Deno.mkdir(artifactRoot);
      const engine = new CfHarnessEngine({
        sandboxRuntime: new SilentSandbox(),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
      });
      await engine.ensureSandboxOutputRoot();

      const root = engine.getRunState().sandboxOutputRoot?.hostPath;
      expect(root).toBeDefined();
      expect(root!.startsWith(`${workspace}/`)).toBe(false);
      expect(root).toBe(
        sandboxOutputRootHostPath(familyDirBesideWorkspace(workspace, runId)),
      );
      expect(engine.sandboxOutputRootFailure).toBeUndefined();
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(familyDirBesideWorkspace(workspace, runId), {
        recursive: true,
      }).catch(() => {});
    }
  });

  it("places it against a pre-resolved sandbox config's own mounts", async () => {
    // A caller can supply a whole sandbox configuration instead of the
    // options one is built from. Deciding placement from the options that
    // configuration REPLACED would read a mount list the run does not have,
    // and the output directory would land inside a mount the workload writes.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-pre-" });
    const extra = await Deno.makeTempDir({ prefix: "cf-harness-extra-" });
    const artifactRoot = join(extra, "artifacts");
    const runId = `pre-${crypto.randomUUID()}`;
    try {
      await Deno.mkdir(artifactRoot);
      const engine = new CfHarnessEngine({
        runId,
        artifactRoot,
        sandbox: resolveDockerRunscSandboxConfig({
          workspaceHostPath: workspace,
          additionalMounts: [{
            kind: "host-bind",
            name: "extra",
            hostPath: extra,
            sandboxPath: "/extra",
            readOnly: false,
          }],
        }),
      });
      await engine.ensureSandboxOutputRoot();

      // The artifact root is inside a writable mount, so the sibling layout
      // is the one that can hold it.
      expect(engine.getRunState().sandboxOutputRoot?.hostPath).toBe(
        sandboxOutputRootHostPath(familyDirBesideWorkspace(workspace, runId)),
      );
      // And the configuration the runtime actually gets carries the mount.
      expect(
        engine.sandbox.describe().cfc?.mounts?.some((mount) =>
          mount.sandboxPath === "/cf-harness/out"
        ),
      ).toBe(true);
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(extra, { recursive: true });
      await Deno.remove(familyDirBesideWorkspace(workspace, runId), {
        recursive: true,
      }).catch(() => {});
    }
  });

  it("refuses a transport directory under the artifact root through the engine", async () => {
    // The resolver refuses it, but only if the engine tells it where the
    // artifact root is.

    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-eng-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    try {
      expect(() =>
        new CfHarnessEngine({
          runId: `eng-${crypto.randomUUID()}`,
          workspaceHostPath: workspace,
          artifactRoot,
          cfcResultDir: join(artifactRoot, "sidecars"),
        })
      ).toThrow(/must not be inside a directory the sandbox can write/);
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("uses the artifact root when that is outside every writable mount", async () => {
    const workspace = await Deno.makeTempDir({ prefix: "cf-harness-place-" });
    const artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-art-" });
    const runId = `place-${crypto.randomUUID()}`;
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new SilentSandbox(),
        runId,
        workspaceHostPath: workspace,
        artifactRoot,
      });
      await engine.ensureSandboxOutputRoot();

      expect(engine.getRunState().sandboxOutputRoot?.hostPath).toBe(
        sandboxOutputRootHostPath(
          familyDirUnderArtifactRoot(artifactRoot, runId),
        ),
      );
    } finally {
      forgetWorkspaceTaintForTesting(runId);
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});

describe("host mount paths", () => {
  // Every host path that will be compared against another is walked apart
  // toward its root. A relative one has no root to reach, so the walk would
  // never end — and a run that hangs during construction never says why.

  it("refuses a relative workspace path", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({ workspaceHostPath: "project" })
    ).toThrow(/workspaceHostPath must be an absolute host path/);
  });

  it("refuses a relative additional-mount path", () => {
    expect(() =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [{
          kind: "host-bind",
          name: "data",
          hostPath: "data",
          sandboxPath: "/data",
          readOnly: false,
        }],
      })
    ).toThrow(/must be an absolute host path/);
  });
});
