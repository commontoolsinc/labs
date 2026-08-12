/**
 * Wiring of the session-local handle table into the prompt loop: address
 * occurrences in model-bound tool output become tokens, tokens in model-
 * written tool input resolve back to addresses, and sealed structured-return
 * strings that name addresses come back as tokens. Everything here is gated
 * on `handleMode: "session"`; the disabled default leaves the loop untouched.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { normalize } from "@std/path/posix";

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const URI_A = `of:fid1:${HASH_A}`;
const LINK_B = `/of:fid1:${HASH_B}/items/0`;

class FakeSandboxRuntime implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  constructor(private readonly shellResults: SandboxCommandResult[] = []) {}

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
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
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

/**
 * Scripts the model side of a run: each call to the returned fetch function
 * consumes the next payload, recording the parsed request body.
 */
const scriptedFetch = (
  payloads: readonly unknown[],
  requestBodies: unknown[] = [],
): typeof fetch =>
(_input, init) => {
  requestBodies.push(JSON.parse(String(init?.body)));
  const payload = payloads[requestBodies.length - 1];
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

const bashCallTurn = (id: string, command: string) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

/** The model-bound tool message nearest the end of `transcript`. */
const lastToolMessageContent = (
  transcript: readonly { role: string; content?: string }[],
): string => {
  const message = transcript.at(-2);
  if (message?.role !== "tool" || typeof message.content !== "string") {
    throw new Error("expected a tool message before the final response");
  }
  return message.content;
};

describe("prompt-loop address handles", () => {
  it("replaces addresses in the model-bound tool output with tokens while artifacts and run state keep the raw forms", async () => {
    const runId = "run-handles-outbound";
    const expectedTokenA =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const expectedTokenB =
      (await mintAddressHandle(createHarnessHandleTable(runId), LINK_B)).token;
    const artifactStore = new RecordingArtifactStore(runId);
    const stdout = `uri ${URI_A} and link ${LINK_B} in prose`;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout, stderr: "", exitCode: 0 },
        ]),
        artifactStore,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat refs.txt"),
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Read the refs." });

    const toolContent = lastToolMessageContent(result.transcript);
    expect(toolContent).toContain(expectedTokenA);
    expect(toolContent).toContain(expectedTokenB);
    expect(toolContent).not.toContain(HASH_A);
    expect(toolContent).not.toContain(HASH_B);
    const persisted = JSON.stringify(artifactStore.toolOutputs[0]?.output);
    expect(persisted).toContain(URI_A);
    expect(persisted).toContain(LINK_B);
    expect(persisted).not.toContain("cfh:a:");
    expect(result.runState.handleTable?.salt).toBe(runId);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token).sort(),
    ).toEqual([expectedTokenA, expectedTokenB].sort());
  });

  it("resolves a token in the next turn's tool input to the canonical address before dispatch", async () => {
    const runId = "run-handles-inbound";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const sandbox = new FakeSandboxRuntime([
      { stdout: `see ${URI_A}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: sandbox,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        bashCallTurn("call-2", `cf get ${minted.token}`),
        finalTurn("Done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Read then fetch." });

    // The bash tool prefixes the model-written command with cwd-marker shell
    // lines, so we match on the command's own text.
    const dispatched = sandbox.shellRequests.find((request) =>
      request.command.includes("cf get ")
    );
    expect(dispatched?.command).toContain(
      `cf get ${minted.table.entries[0]?.ref}`,
    );
    expect(dispatched?.command).not.toContain(minted.token);
  });

  it("returns the same token when the same address appears in two tool outputs", async () => {
    const runId = "run-handles-stable";
    const expectedToken =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: `first ${URI_A}`, stderr: "", exitCode: 0 },
          { stdout: `second ${URI_A}`, stderr: "", exitCode: 0 },
        ]),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        bashCallTurn("call-2", "cat b.txt"),
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Read both files." });

    const toolMessages = result.transcript.filter((
      message,
    ): message is typeof message & { content: string } =>
      message.role === "tool"
    );
    expect(toolMessages.length).toBe(2);
    for (const message of toolMessages) {
      expect(message.content).toContain(expectedToken);
      expect(message.content).not.toContain(HASH_A);
    }
    expect(result.runState.handleTable?.entries.length).toBe(1);
  });

  it("passes a token in a `delegate_task` goal to the child verbatim", async () => {
    const runId = "run-handles-delegate";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
      handleMode: "session",
    });
    await engine.recordHandleTable(minted.table);
    const requestBodies: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: `Inspect ${minted.token} and report.`,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies as unknown[]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const childUserPrompt =
      chatViewOfRequest(requestBodies[1]).messages[1]?.content ?? "";
    expect(childUserPrompt).toContain(minted.token);
    expect(childUserPrompt).not.toContain(HASH_A);
  });

  it("returns a sealed structured-return string that names an address as a token while a free-form string stays opaque", async () => {
    const runId = "run-handles-post";
    const childRunId = `${runId}.subagent.1`;
    const expectedToken =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const returnSchema = {
      type: "object",
      properties: {
        link: { type: "string" },
        note: { type: "string" },
      },
      required: ["link", "note"],
      additionalProperties: false,
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-structured",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Find the cell.",
                    returnSchema,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn(JSON.stringify({ link: URI_A, note: "free-form prose" })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    const output = JSON.parse(lastToolMessageContent(result.transcript)) as {
      subagent: {
        structuredReturn: { value: unknown; linkedStringCount: number };
      };
    };
    expect(output.subagent.structuredReturn.value).toEqual({
      link: expectedToken,
      note: { "@link": `opaque:${childRunId}#/note` },
    });
    expect(output.subagent.structuredReturn.linkedStringCount).toBe(1);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token),
    ).toEqual([expectedToken]);
  });

  it("reuses the rehydrated table on resume, re-swapping to the same token and resolving it inbound", async () => {
    const runId = "run-handles-resume";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const firstLoop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: `see ${URI_A}`, stderr: "", exitCode: 0 },
        ]),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        finalTurn("First run done."),
      ]),
    });
    const firstResult = await firstLoop.runPrompt({ prompt: "Read the ref." });
    expect(firstResult.runState.handleTable?.entries.length).toBe(1);

    const resumedSandbox = new FakeSandboxRuntime([
      { stdout: `again ${URI_A}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const resumedLoop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: resumedSandbox,
        runState: firstResult.runState,
        handleMode: "session",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-2", "cat a.txt"),
        bashCallTurn("call-3", `cf get ${minted.token}`),
        finalTurn("Resumed run done."),
      ]),
    });
    const resumedResult = await resumedLoop.runTranscript({
      transcript: [...firstResult.transcript, {
        role: "user",
        content: "Read it again, then fetch it.",
      }],
      model: "gpt-5.4",
    });

    const toolMessages = resumedResult.transcript.filter((
      message,
    ): message is typeof message & { content: string } =>
      message.role === "tool"
    );
    const reswapped = toolMessages.at(-2);
    expect(reswapped?.content).toContain(minted.token);
    expect(reswapped?.content).not.toContain(HASH_A);
    expect(resumedResult.runState.handleTable?.entries.length).toBe(1);
    const dispatched = resumedSandbox.shellRequests.find((request) =>
      request.command.includes("cf get ")
    );
    expect(dispatched?.command).toContain(
      `cf get ${minted.table.entries[0]?.ref}`,
    );
    expect(dispatched?.command).not.toContain(minted.token);
  });

  it("leaves an address untouched and records no table when `handleMode` is unset", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: `see ${URI_A}`, stderr: "", exitCode: 0 },
        ]),
        runId: "run-handles-disabled",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Read the ref." });

    const toolContent = lastToolMessageContent(result.transcript);
    expect(toolContent).toContain(URI_A);
    expect(toolContent).not.toContain("cfh:a:");
    expect(result.runState.handleTable).toBe(undefined);
  });

  it("passes a token abutting alphabet characters through inbound substitution untouched", async () => {
    const runId = "run-handles-adjacency";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
      handleMode: "session",
    });
    await engine.recordHandleTable(minted.table);
    const sandbox = engine.sandbox as FakeSandboxRuntime;
    const command = `note ${minted.token}abc end`;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", command),
        finalTurn("Done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Note it down." });

    const dispatched = sandbox.shellRequests.find((request) =>
      request.command.includes("note ")
    );
    expect(dispatched?.command).toContain(command);
  });
});
