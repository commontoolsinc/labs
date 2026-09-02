/**
 * The run's outcome on disk, as a poller reads `run-state.json`: terminal
 * exactly when the run is over, and terminal after every way a run can die.
 * The loop and the setup phase are the only writers of that outcome, so each
 * case drives one of them and reads the file where a poller would.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";

import { readHarnessRunState } from "../src/artifacts.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessModelClient } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { establishHarnessSessionContext } from "../src/session-assembly.ts";

const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForRunLifecycleTest/of:fid1:${
  "B".repeat(43)
}/x`;

/** A sandbox that answers the capability probe and one canned shell result. */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
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

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve(
      request.command.includes(CAPABILITY_PROBE_SENTINEL)
        ? {
          stdout:
            "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
          stderr: "",
          exitCode: 0,
        }
        : { stdout: "one\n", stderr: "", exitCode: 0 },
    );
  }
}

const runStatePath = (artifactRoot: string, runId: string): string =>
  join(artifactRoot, runId, "run-state.json");

const bashCallTurn = {
  assistant: {
    role: "assistant" as const,
    content: "",
    toolCalls: [{
      id: "call-1",
      type: "function" as const,
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "echo one" }),
      },
    }],
  },
};

/**
 * A loop whose model makes one tool call and then does whatever `then`
 * says. Before that second turn is answered, the run's file is read the way
 * a poller reads it, and the snapshot is kept in `seen`.
 */
const loopAfterOneToolCall = (
  artifactRoot: string,
  runId: string,
  then: () => Promise<Awaited<ReturnType<HarnessModelClient["complete"]>>>,
): { loop: CfHarnessPromptLoop; seen: HarnessRunState[] } => {
  const seen: HarnessRunState[] = [];
  let turns = 0;
  const modelClient: HarnessModelClient = {
    providerId: "test-provider",
    async complete() {
      turns += 1;
      if (turns === 1) {
        return bashCallTurn;
      }
      seen.push(await readHarnessRunState(runStatePath(artifactRoot, runId)));
      return await then();
    },
  };
  const loop = new CfHarnessPromptLoop({
    modelClient,
    engine: new CfHarnessEngine({
      artifactRoot,
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "test-model",
      cfcEnforcementMode: "disabled",
    }),
  });
  return { loop, seen };
};

const withArtifactRoot = async (
  body: (artifactRoot: string) => Promise<void>,
): Promise<void> => {
  const artifactRoot = await Deno.makeTempDir({
    prefix: "cf-harness-run-lifecycle-",
  });
  try {
    await body(artifactRoot);
  } finally {
    await Deno.remove(artifactRoot, { recursive: true });
  }
};

describe("run-lifecycle", () => {
  describe("CfHarnessPromptLoop", () => {
    it("reads `running` on disk between a tool call and the model's next turn", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-tool-call-then-answer";
        const { loop, seen } = loopAfterOneToolCall(
          artifactRoot,
          runId,
          () =>
            Promise.resolve({
              assistant: { role: "assistant", content: "done" },
            }),
        );

        await loop.runPrompt({ prompt: "run one command" });

        expect(seen).toHaveLength(1);
        expect(seen[0].status).toBe("running");
        expect(seen[0].endedAt).toBeUndefined();
        expect(seen[0].terminalReason).toBeUndefined();
        expect(seen[0].toolOutputs).toHaveLength(1);
        const settled = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(settled.status).toBe("completed");
        expect(settled.terminalReason).toBe("assistant_completed");
        expect(settled.endedAt).toBeDefined();
      });
    });

    it("settles to `failed` with `prompt_loop_error` when the model fails after a tool call", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-tool-call-then-provider-error";
        const { loop, seen } = loopAfterOneToolCall(
          artifactRoot,
          runId,
          () =>
            Promise.reject(
              new Error("model stream returned an error event"),
            ),
        );

        await expect(loop.runPrompt({ prompt: "run one command" })).rejects
          .toThrow("model stream returned an error event");

        expect(seen[0].status).toBe("running");
        expect(seen[0].endedAt).toBeUndefined();
        const settled = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(settled.status).toBe("failed");
        expect(settled.terminalReason).toBe("prompt_loop_error");
        expect(settled.endedAt).toBeDefined();
        expect(settled.primaryFailure?.detail).toBe(
          "model stream returned an error event",
        );
      });
    });
  });

  describe("establishHarnessSessionContext()", () => {
    const engineWithInputCell = (
      artifactRoot: string,
      runId: string,
      ref: string,
    ): CfHarnessEngine =>
      new CfHarnessEngine({
        artifactRoot,
        runId,
        workspaceHostPath: "/host/project",
        inputCells: [{ name: "account", ref }],
        fabricSessionFactory: () =>
          Promise.resolve(
            {
              pieces: { getSpace: () => SPACE_DID },
              // deno-lint-ignore no-explicit-any
            } as any,
          ),
      });

    it("takes the run to `running` on disk before its first model turn", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-setup-succeeds";
        const engine = engineWithInputCell(
          artifactRoot,
          runId,
          `/of:fid1:${"A".repeat(43)}/account`,
        );

        await establishHarnessSessionContext({
          engine,
          config: { skillNames: [] },
        });

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(state.status).toBe("running");
        expect(state.endedAt).toBeUndefined();
        expect(state.inputCells).toHaveLength(1);
      });
    });

    it("leaves the run `failed` with `setup_error` on disk when an input cell cannot be minted", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-setup-fails";
        const engine = engineWithInputCell(artifactRoot, runId, FOREIGN_REF);

        await expect(
          establishHarnessSessionContext({
            engine,
            config: { skillNames: [] },
          }),
        ).rejects.toThrow("targets another space");

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(state.status).toBe("failed");
        expect(state.terminalReason).toBe("setup_error");
        expect(state.endedAt).toBeDefined();
        expect(state.primaryFailure?.detail).toContain("targets another space");
        expect(state.inputCells).toBeUndefined();
      });
    });
  });
});
