/**
 * The model-facing boundary of `run_pattern` diagnostics: compiler messages
 * can embed compiler-generated bare fabric identifiers (the `/fid1:.../`
 * virtual module roots) which the handle boundary deliberately never swaps,
 * so the prompt loop scrubs them from the model-bound rendering while the
 * persisted artifact keeps the raw text.
 */

import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { scrubBareFabricIdentifiers } from "../src/tools/run-pattern.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

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
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/** Artifact store that records tool outputs in memory, touching no disk. */
class RecordingArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot = "/artifacts";
  readonly runRoot: string;
  readonly toolOutputs: Array<{
    toolId: string;
    outputId: string;
    output: unknown;
  }> = [];

  constructor(runId: string) {
    this.runRoot = `${this.artifactRoot}/${runId}`;
  }

  persistRunState(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-state.json`);
  }

  persistTranscript(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/transcript.json`);
  }

  persistCapabilitySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/capabilities.json`);
  }

  persistCfcPolicySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/policy-snapshot.json`);
  }

  persistRunReport(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-report.json`);
  }

  persistToolOutput(
    toolId: string,
    outputId: string,
    output: unknown,
  ): Promise<string> {
    this.toolOutputs.push({ toolId, outputId, output });
    return Promise.resolve(
      `${this.runRoot}/tool-outputs/${outputId}-${toolId}.json`,
    );
  }
}

describe("prompt-loop run_pattern model boundary", () => {
  describe("scrubBareFabricIdentifiers()", () => {
    it("replaces bare tagged hashes, DIDs, and data URIs with the placeholder", () => {
      const hash = "A".repeat(43);
      expect(scrubBareFabricIdentifiers(
        `Could not resolve "/fid1:${hash}/missing.ts".`,
      )).toBe('Could not resolve "/[fabric-id]/missing.ts".');
      expect(scrubBareFabricIdentifiers("space did:key:z6MkfffTest denied"))
        .toBe("space [fabric-id] denied");
      expect(scrubBareFabricIdentifiers("at data:application/json;base64,AAAA"))
        .toBe("at [fabric-id]");
    });

    it("leaves schemed link forms and handle tokens untouched", () => {
      const hash = "B".repeat(43);
      const schemed = `/of:fid1:${hash}/items/0`;
      const computed = `computed:fid1:${hash}`;
      const token = "cfh:a:abcde";
      const text = `see ${schemed} then ${computed} and ${token}`;
      expect(scrubBareFabricIdentifiers(text)).toBe(text);
    });
  });

  it("records the compiled pattern's result schema on the handle minted for its result reference", async () => {
    const signer = await Identity.fromPassphrase("run-pattern result schema");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-schema-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-result-schema";
      const doublingSource = [
        "import { computed, pattern } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const payload = requestBodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: doublingSource,
                      inputs: { n: 3 },
                    }),
                  },
                }],
              },
            }],
          }
          : {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
            }],
          };
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId,
          model: "gpt-5.4",
          cfcEnforcementMode: "disabled",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({ prompt: "Run the pattern." });

      // One handle: the result reference, carrying the shape compilation
      // already knew, so the token is checkable without reading the cell.
      const entries = result.runState.handleTable?.entries ?? [];
      expect(entries.length).toBe(1);
      const schema = entries[0]?.schema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema?.properties?.doubled).toBeDefined();
      // The schema reaches the model through the token, not inline.
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("resultRefSchema");
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("keeps bare fabric identifiers in compile diagnostics out of the model-facing tool message while the artifact keeps the raw text", async () => {
    const signer = await Identity.fromPassphrase("run-pattern scrub");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-scrub-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-scrub";
      const artifactStore = new RecordingArtifactStore(runId);
      const brokenSource = [
        "import { computed, pattern } from 'commonfabric';",
        "import { helper } from './missing.ts';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => helper(n)) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const payload = requestBodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({ sourceText: brokenSource }),
                  },
                }],
              },
            }],
          }
          : {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
            }],
          };
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          cfcEnforcementMode: "disabled",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({ prompt: "Run the pattern." });

      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toBeDefined();
      const toolContent = toolMessage!.content!;
      const parsed = JSON.parse(toolContent) as {
        status: string;
        message: string;
      };
      expect(parsed.status).toBe("compile-error");
      expect(parsed.message).toContain("[fabric-id]");
      expect(toolContent).not.toMatch(/fid1:[A-Za-z0-9_-]{43}/);
      expect(toolContent).not.toContain("did:key:");
      expect(toolContent).not.toContain("data:");
      // The persisted artifact keeps the raw diagnostic — the scrub is a
      // model-boundary rendering, not a rewrite of the record.
      const persisted = artifactStore.toolOutputs.find(
        (entry) => entry.toolId === "run_pattern",
      );
      const persistedMessage =
        (persisted?.output as { message: string }).message;
      expect(persistedMessage).toMatch(/fid1:[A-Za-z0-9_-]{43}/);
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });
});
