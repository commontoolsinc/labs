/**
 * Cross-agent handle semantics: a delegation seeds the child's handle table
 * with exactly the entries the parent named in the delegation, the child
 * resolves those tokens through its own boundary, and a reference the child
 * produces comes back to the parent as a token the parent can resolve.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { type Cell, isCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import { HANDLE_TOKEN_PATTERN } from "../src/contracts/handle-table.ts";
import {
  DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
  PATTERN_AUTHOR_SUBAGENT_MAX_MODEL_TURNS,
} from "../src/contracts/subagent.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import { createPatternSkillsFixture } from "./support/pattern-skills-fixture.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const HASH_C = "C".repeat(43);
const URI_A = `of:fid1:${HASH_A}`;
const URI_B = `of:fid1:${HASH_B}`;
const URI_C = `of:fid1:${HASH_C}`;

class FakeSandboxRuntime implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #shellResults: SandboxCommandResult[];

  constructor(shellResults: SandboxCommandResult[] = []) {
    this.#shellResults = shellResults;
  }

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
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

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

const delegateCallTurn = (id: string, input: Record<string, unknown>) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "delegate_task",
          arguments: JSON.stringify(input),
        },
      }],
    },
  }],
});

const runPatternCallTurn = (id: string, input: Record<string, unknown>) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "run_pattern",
          arguments: JSON.stringify(input),
        },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

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

/** A parent table holding one entry per address, in the order given. */
const parentTableOf = async (
  runId: string,
  refs: readonly string[],
): Promise<HarnessHandleTable> => {
  let table = createHarnessHandleTable(runId);
  for (const ref of refs) {
    table = (await mintAddressHandle(table, ref)).table;
  }
  return table;
};

/** The first handle token in `text`, or `undefined` when it holds none. */
const firstToken = (text: string): string | undefined =>
  text.match(new RegExp(HANDLE_TOKEN_PATTERN))?.[0];

/** The shell request whose model-written command contains `needle`. */
const dispatchedCommand = (
  sandbox: FakeSandboxRuntime,
  needle: string,
): string => {
  const request = sandbox.shellRequests.find((candidate) =>
    candidate.command.includes(needle)
  );
  if (request === undefined) {
    throw new Error(`no dispatched command contained \`${needle}\``);
  }
  return request.command;
};

describe("prompt-loop cross-agent address handles", () => {
  it("resolves a token named in the delegate_task goal against the child's own table", async () => {
    const runId = "run-subagent-handles-seeded";
    const table = await parentTableOf(runId, [URI_A]);
    const token = table.entries[0]!.token;
    const sandbox = new FakeSandboxRuntime();
    const engine = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: `Inspect ${token} and report what it holds.`,
        }),
        bashCallTurn("call-child", `cf cell get ${token}`),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const command = dispatchedCommand(sandbox, "cf cell get ");
    expect(command).toContain(`cf cell get ${table.entries[0]!.ref}`);
    expect(command).not.toContain(token);
  });

  it("leaves a token the delegation never named unresolved in the child", async () => {
    const runId = "run-subagent-handles-privilege";
    const table = await parentTableOf(runId, [URI_A, URI_B]);
    const sharedToken = table.entries[0]!.token;
    const withheldToken = table.entries[1]!.token;
    const sandbox = new FakeSandboxRuntime();
    const engine = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: `Inspect ${sharedToken}.`,
          context: "The other cell is out of scope for this task.",
        }),
        // A child that guesses at a token it was never handed.
        bashCallTurn(
          "call-child",
          `cf cell get ${sharedToken} ${withheldToken}`,
        ),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const command = dispatchedCommand(sandbox, "cf cell get ");
    expect(command).toContain(table.entries[0]!.ref);
    expect(command).toContain(withheldToken);
    expect(command).not.toContain(HASH_B);
  });

  it("gives a delegation that names no token a child with no handles at all", async () => {
    const runId = "run-subagent-handles-unseeded";
    const table = await parentTableOf(runId, [URI_A]);
    const parentToken = table.entries[0]!.token;
    const sandbox = new FakeSandboxRuntime();
    const engine = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        // The delegation names no handle, so nothing of the parent's reaches
        // the child: what a child can resolve is what the delegation handed
        // it, and here that is nothing.
        delegateCallTurn("call-delegate", {
          goal: "Summarize the workspace README.",
        }),
        bashCallTurn("call-child", `cf cell get ${parentToken}`),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Delegate the summary." });

    // A token the child guessed at names nothing in the child, so it reaches
    // the sandbox as the inert text it is rather than as an address.
    const command = dispatchedCommand(sandbox, "cf cell get ");
    expect(command).toContain(parentToken);
    expect(command).not.toContain(HASH_A);
  });

  it("shows the child the token rather than the reference in its own prompt", async () => {
    const runId = "run-subagent-handles-prompt";
    const table = await parentTableOf(runId, [URI_A]);
    const token = table.entries[0]!.token;
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: `Summarize ${token}.`,
          context: `Compare it with ${token} only.`,
        }),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies),
    });

    await loop.runPrompt({ prompt: "Delegate the summary." });

    const childMessages = chatViewOfRequest(requestBodies[1]).messages
      .map((message) => message.content ?? "")
      .join("\n");
    expect(childMessages).toContain(token);
    expect(childMessages).not.toContain(HASH_A);
  });

  it("returns an address the child discovered to the parent as a parent-resolvable token", async () => {
    const runId = "run-subagent-handles-return";
    const parentTokenC =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_C)).token;
    const sandbox = new FakeSandboxRuntime([
      { stdout: `child found ${URI_C}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const requestBodies: unknown[] = [];
    // The child reports the token its own boundary minted, and the parent
    // then works on the token it received, so both sides are scripted off
    // the transcript rather than as fixed text.
    const fetchFn: typeof fetch = (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const turn = requestBodies.length;
      const lastToolContent = (index: number): string => {
        const messages = chatViewOfRequest(requestBodies[index]).messages;
        const message = [...messages].reverse().find((candidate) =>
          candidate.role === "tool"
        );
        return message?.content ?? "";
      };
      const payload = turn === 1
        ? delegateCallTurn("call-delegate", { goal: "Find the cell." })
        : turn === 2
        ? bashCallTurn("call-child", "cat found.txt")
        : turn === 3
        ? finalTurn(`The cell is ${firstToken(lastToolContent(2))}.`)
        : turn === 4
        ? bashCallTurn(
          "call-parent",
          `cf cell get ${firstToken(lastToolContent(3))}`,
        )
        : finalTurn("Parent done.");
      return Promise.resolve(
        new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
          status: 200,
        }),
      );
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: sandbox,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn,
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    const delegateOutput = chatViewOfRequest(requestBodies[3]).messages
      .filter((message) => message.role === "tool")
      .at(-1)?.content ?? "";
    expect(delegateOutput).toContain(parentTokenC);
    expect(delegateOutput).not.toContain(HASH_C);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token),
    ).toEqual([parentTokenC]);
    const command = dispatchedCommand(sandbox, "cf cell get ");
    expect(command).toContain(
      `cf cell get ${result.runState.handleTable?.entries[0]?.ref}`,
    );
    expect(command).not.toContain(parentTokenC);
  });

  it("returns a reference whose path segment is token-shaped whole", async () => {
    const runId = "run-subagent-handles-token-shaped-path";
    // A cell whose path segment reads exactly like a handle token. Nothing
    // stops an author naming a key that way, and the reference is the only
    // thing that addresses the cell.
    const pathed = `${URI_C}/cfh:a:23456`;
    const sandbox = new FakeSandboxRuntime([
      { stdout: `child found ${pathed}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const requestBodies: unknown[] = [];
    const fetchFn: typeof fetch = (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const turn = requestBodies.length;
      const lastToolContent = (index: number): string => {
        const messages = chatViewOfRequest(requestBodies[index]).messages;
        return [...messages].reverse().find((candidate) =>
          candidate.role === "tool"
        )?.content ?? "";
      };
      const payload = turn === 1
        ? delegateCallTurn("call-delegate", { goal: "Find the cell." })
        : turn === 2
        ? bashCallTurn("call-child", "cat found.txt")
        : turn === 3
        ? finalTurn(`The cell is ${firstToken(lastToolContent(2))}.`)
        : turn === 4
        ? bashCallTurn(
          "call-parent",
          `cf cell get ${firstToken(lastToolContent(3))}`,
        )
        : finalTurn("Parent done.");
      return Promise.resolve(
        new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
          status: 200,
        }),
      );
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: sandbox,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn,
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    // The child's token resolves to its reference in the same scan that
    // scrubs the unresolvable ones, so the path segment inside that
    // reference is never re-read as a token of its own.
    const entry = result.runState.handleTable?.entries[0];
    expect(entry?.ref).toContain("/cfh:a:23456");
    const delegateOutput = chatViewOfRequest(requestBodies[3]).messages
      .filter((message) => message.role === "tool")
      .at(-1)?.content ?? "";
    expect(delegateOutput).not.toContain("[handle-token-removed]");
    // And the parent can still address the cell the child reported.
    expect(dispatchedCommand(sandbox, "cf cell get ")).toContain(
      `cf cell get ${entry?.ref}`,
    );
  });

  it("scrubs a token-shaped string a child returns rather than letting the parent resolve it", async () => {
    const runId = "run-subagent-handles-crossing";
    const table = await parentTableOf(runId, [URI_A, URI_B]);
    const sharedToken = table.entries[0]!.token;
    const withheldToken = table.entries[1]!.token;
    const sandbox = new FakeSandboxRuntime();
    const engine = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const requestBodies: unknown[] = [];
    // The parent works on whatever token the child's report carries, so the
    // crossing is scripted off the transcript rather than as fixed text.
    const fetchFn: typeof fetch = (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const turn = requestBodies.length;
      const delegateOutput = (): string => {
        const messages = chatViewOfRequest(requestBodies[2]).messages;
        return [...messages].reverse().find((candidate) =>
          candidate.role === "tool"
        )?.content ?? "";
      };
      const payload = turn === 1
        ? delegateCallTurn("call-delegate", { goal: `Inspect ${sharedToken}.` })
        // The child names a token it was never handed. It resolves to nothing
        // in the child's own table, so it would otherwise cross unchanged.
        : turn === 2
        ? finalTurn(`Also look at ${withheldToken}.`)
        : turn === 3
        ? bashCallTurn(
          "call-parent",
          `cf cell get ${firstToken(delegateOutput())}`,
        )
        : finalTurn("Parent done.");
      return Promise.resolve(
        new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
          status: 200,
        }),
      );
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn,
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const delegateOutput = chatViewOfRequest(requestBodies[2]).messages
      .filter((message) => message.role === "tool")
      .at(-1)?.content ?? "";
    expect(delegateOutput).not.toContain(withheldToken);
    expect(delegateOutput).toContain("[handle-token-removed]");
    // The parent has nothing to pick up from the report, so the address the
    // delegation withheld never reaches the parent's own tool call.
    const command = dispatchedCommand(sandbox, "cf cell get ");
    expect(command).not.toContain(HASH_B);
  });

  it("keeps `run_pattern` out of the child tool surface when no fabric session is configured", async () => {
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-subagent-handles-no-session",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", { goal: "Do the task." }),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the task." });

    expect(chatViewOfRequest(requestBodies[1]).tools).toEqual([
      "bash",
      "read_file",
      "view_image",
      "edit_file",
      "write_file",
    ]);
    const runRef = result.runState.subagentRuns?.[0];
    expect(runRef?.manifest.allowedToolIds).not.toContain("run_pattern");
  });

  it("rejects a `pattern-author` delegation when the profile is not allowed in the run", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-subagent-pattern-author-denied",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      allowedSubagentProfiles: ["default"],
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: "Author a pattern.",
          profile: "pattern-author",
        }),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the authoring." });

    expect(result.runState.subagentRuns ?? []).toEqual([]);
    expect(
      result.runState.policyEvents.some((event) =>
        event.severity === "denied" &&
        event.detail?.includes("pattern-author") === true
      ),
    ).toBe(true);
  });

  it("keeps `run_pattern` out of the `pattern-author` child tool surface when no fabric session is configured", async () => {
    await using fixture = await createPatternSkillsFixture();
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-subagent-pattern-author-no-session",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        skillsRoot: fixture.skillsRoot,
      }),
      allowedSubagentProfiles: ["pattern-author"],
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: "Author a pattern.",
          profile: "pattern-author",
        }),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the authoring." });

    expect(chatViewOfRequest(requestBodies[1]).tools).toEqual([
      "bash",
      "read_file",
      "read_skill_resource",
      "describe_handle",
      "query_docs",
    ]);
    const runRef = result.runState.subagentRuns?.[0];
    expect(runRef?.manifest.allowedToolIds).not.toContain("run_pattern");
  });

  it("tells the `pattern-author` child to wire its input references into the pattern rather than read them", async () => {
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-subagent-pattern-author-prompt",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      allowedSubagentProfiles: ["pattern-author"],
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: "Author a pattern.",
          profile: "pattern-author",
        }),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies),
    });

    await loop.runPrompt({ prompt: "Delegate the authoring." });

    const childSystemPrompt =
      chatViewOfRequest(requestBodies[1]).messages[0]!.content ?? "";
    expect(childSystemPrompt).toContain("Subagent profile: pattern-author");
    expect(childSystemPrompt).toContain(
      "Every reference in your task is an address, not a value.",
    );
    expect(childSystemPrompt).toContain(
      "You own the write, compile-error, fix",
    );
    expect(childSystemPrompt).toContain(
      "Return the resultRef run_pattern gave you for the pattern you ran last",
    );
    // The deliverable is a reference to something that ran, and source is
    // refused rather than merely discouraged: an encoding is still source.
    expect(childSystemPrompt).toContain("You never return source.");
    expect(childSystemPrompt).toContain(
      "not as an array of code points or bytes",
    );
    expect(childSystemPrompt).toContain(
      "Build up in atoms rather than in one leap.",
    );
    expect(childSystemPrompt).toContain(
      "A whole-result derived wrapper is a known smell",
    );
    expect(childSystemPrompt).toContain(
      "run_pattern checks the actual pattern pointer",
    );
    expect(childSystemPrompt).not.toContain(
      "Never return a computed(), lift, or other derived wrapper",
    );
  });

  it("runs a `pattern-author` child on the profile's own turn budget rather than the run default", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-subagent-pattern-author-budget",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      allowedSubagentProfiles: ["pattern-author"],
      fetchFn: scriptedFetch([
        delegateCallTurn("call-delegate", {
          goal: "Author a pattern.",
          profile: "pattern-author",
        }),
        finalTurn(JSON.stringify({ ok: false, reason: "No fabric session." })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the authoring." });

    const runRef = result.runState.subagentRuns?.[0];
    expect(runRef?.manifest.maxModelTurns).toBe(
      PATTERN_AUTHOR_SUBAGENT_MAX_MODEL_TURNS,
    );
    expect(runRef?.manifest.maxModelTurns).not.toBe(
      DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
    );
  });

  it("returns the failure branch from a `pattern-author` child that cannot succeed, distinguishable from success by shape", async () => {
    const runId = "run-subagent-pattern-author-contract";
    const table = await parentTableOf(runId, [URI_A]);
    const token = table.entries[0]!.token;
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(table);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      allowedSubagentProfiles: ["pattern-author"],
      // No delegation declares a `returnSchema`, so both children answer
      // under the profile's own contract.
      fetchFn: scriptedFetch([
        delegateCallTurn("call-failing", {
          goal: `Author a pattern over ${token}.`,
          profile: "pattern-author",
        }),
        finalTurn(JSON.stringify({
          ok: false,
          reason: "The source never compiled.",
        })),
        delegateCallTurn("call-succeeding", {
          goal: `Author a pattern over ${token}, again.`,
          profile: "pattern-author",
        }),
        finalTurn(JSON.stringify({
          ok: true,
          resultRef: token,
          describes: "Counts the entries.",
        })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the authoring." });

    const returnedValue = (index: number): Record<string, unknown> =>
      (result.runState.subagentRuns?.[index] as
        | { structuredReturn?: { value?: Record<string, unknown> } }
        | undefined)?.structuredReturn?.value ?? {};
    const failure = returnedValue(0);
    const success = returnedValue(1);
    // The discriminant, not the prose, is what the parent reads: a failure
    // carries no reference at all, so it cannot be mistaken for a result.
    expect(failure.ok).toBe(false);
    expect("resultRef" in failure).toBe(false);
    expect(success.ok).toBe(true);
    expect(success.resultRef).toBe(token);
  });

  it("reports a well-formed failure branch as the child's answer rather than as a broken return", async () => {
    const runId = "run-subagent-pattern-author-valid-failure";
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      allowedSubagentProfiles: ["pattern-author"],
      fetchFn: scriptedFetch([
        delegateCallTurn("call-failing", {
          goal: "Author a pattern that cannot be written.",
          profile: "pattern-author",
        }),
        // The profile's contract, answered exactly: a failure branch that
        // FITS the schema is a complete answer, not a validation problem.
        finalTurn(JSON.stringify({ ok: false, code: "compile-error" })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the authoring." });

    const subagentRun = result.runState.subagentRuns?.[0] as {
      summary?: string;
      structuredReturn?: { status?: string; failureCode?: string };
    };
    expect(subagentRun.structuredReturn?.status).toBe("valid");
    expect(subagentRun.structuredReturn?.failureCode).toBe("compile-error");
    expect(subagentRun.summary).toBe(
      "Subagent reported failure (compile-error).",
    );
  });

  it("offers `run_pattern` to the child and returns its result ref as a token the parent can pass back to a pattern", async () => {
    const runId = "run-subagent-handles-run-pattern";
    const signer = await Identity.fromPassphrase(
      "subagent run-pattern handles",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `subagent-run-pattern-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const created: Array<{
        input: Record<string, unknown> | undefined;
        piece: Cell<unknown>;
      }> = [];
      const originalRunPersistent = pieces.runPersistent.bind(pieces);
      pieces.runPersistent = (async (
        ...args: Parameters<PiecesController["runPersistent"]>
      ) => {
        const piece = await originalRunPersistent(...args);
        created.push({
          input: args[1] as Record<string, unknown> | undefined,
          piece,
        });
        return piece;
      }) as PiecesController["runPersistent"];
      const doublingSource = [
        "import { computed, pattern } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2) }),",
        ");",
      ].join("\n");
      const echoSource = [
        "import { computed, pattern } from 'commonfabric';",
        "interface Source { doubled: number; }",
        "export default pattern<{ src: Source }, { copied: number }>(",
        "  ({ src }) => ({ copied: computed(() => src.doubled) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const turn = requestBodies.length;
        const lastToolContent = (index: number): string => {
          const messages = chatViewOfRequest(requestBodies[index]).messages;
          const message = [...messages].reverse().find((candidate) =>
            candidate.role === "tool"
          );
          return message?.content ?? "";
        };
        const payload = turn === 1
          ? delegateCallTurn("call-delegate", {
            goal: "Run a pattern that doubles 3 and report its result cell.",
          })
          : turn === 2
          ? runPatternCallTurn("call-child", {
            sourceText: doublingSource,
            inputs: { n: 3 },
          })
          : turn === 3
          ? finalTurn(`The result cell is ${firstToken(lastToolContent(2))}.`)
          : turn === 4
          ? runPatternCallTurn("call-parent", {
            sourceText: echoSource,
            inputs: { src: firstToken(lastToolContent(3)) },
          })
          : finalTurn("Parent done.");
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

      await loop.runPrompt({ prompt: "Delegate the pattern run." });

      expect(chatViewOfRequest(requestBodies[1]).tools).toContain(
        "run_pattern",
      );
      // The child ran one pattern and the parent ran another against the
      // child's result cell, which it reached through the token the
      // delegation returned.
      expect(created.length).toBe(2);
      const src = created[1]?.input?.src;
      expect(isCell(src)).toBe(true);
      const childResultCell = await new PieceController(
        pieces,
        created[0]!.piece,
      ).result.getCell();
      expect((src as Cell<unknown>).getAsNormalizedFullLink().id).toBe(
        childResultCell.getAsNormalizedFullLink().id,
      );
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("resolves a delegated reference inside the `pattern-author` child's own `run_pattern` and returns its result reference as a parent token", async () => {
    const runId = "run-subagent-pattern-author-round-trip";
    const signer = await Identity.fromPassphrase("pattern-author handles");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `pattern-author-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const created: Array<{
        input: Record<string, unknown> | undefined;
        piece: Cell<unknown>;
      }> = [];
      const originalRunPersistent = pieces.runPersistent.bind(pieces);
      pieces.runPersistent = (async (
        ...args: Parameters<PiecesController["runPersistent"]>
      ) => {
        const piece = await originalRunPersistent(...args);
        created.push({
          input: args[1] as Record<string, unknown> | undefined,
          piece,
        });
        return piece;
      }) as PiecesController["runPersistent"];
      const doublingSource = [
        "import { computed, pattern } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2) }),",
        ");",
      ].join("\n");
      const copySource = [
        "import { computed, pattern } from 'commonfabric';",
        "interface Source { doubled: number; }",
        "export default pattern<{ src: Source }, { copied: number }>(",
        "  ({ src }) => ({ copied: computed(() => src.doubled) }),",
        ");",
      ].join("\n");
      const recopySource = [
        "import { computed, pattern } from 'commonfabric';",
        "interface Source { copied: number; }",
        "export default pattern<{ src: Source }, { again: number }>(",
        "  ({ src }) => ({ again: computed(() => src.copied) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      // The parent runs the seed pattern, hands the child the token for its
      // result cell, and finally runs a third pattern against whatever token
      // the delegation returned — so every reference in the script is read
      // back off the transcript rather than written in as fixed text.
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const turn = requestBodies.length;
        const lastToolContent = (index: number): string => {
          const messages = chatViewOfRequest(requestBodies[index]).messages;
          const message = [...messages].reverse().find((candidate) =>
            candidate.role === "tool"
          );
          return message?.content ?? "";
        };
        const payload = turn === 1
          ? runPatternCallTurn("call-seed", {
            sourceText: doublingSource,
            inputs: { n: 3 },
          })
          : turn === 2
          ? delegateCallTurn("call-delegate", {
            profile: "pattern-author",
            goal: `Copy the doubled value held by ${
              firstToken(lastToolContent(1))
            }.`,
          })
          : turn === 3
          ? runPatternCallTurn("call-child", {
            sourceText: copySource,
            inputs: { src: firstToken(lastToolContent(1)) },
          })
          : turn === 4
          // The profile's own return contract applies to a delegation that
          // declared none, so the child answers in its success branch.
          ? finalTurn(JSON.stringify({
            ok: true,
            resultRef: firstToken(lastToolContent(3)),
            describes: "Copies the doubled value.",
          }))
          : turn === 5
          ? runPatternCallTurn("call-parent", {
            sourceText: recopySource,
            inputs: { src: firstToken(lastToolContent(4)) },
          })
          : finalTurn("Parent done.");
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
        allowedSubagentProfiles: ["pattern-author"],
        fetchFn,
      });

      await loop.runPrompt({ prompt: "Delegate the copy." });

      expect(chatViewOfRequest(requestBodies[2]).tools).toContain(
        "run_pattern",
      );
      expect(created.length).toBe(3);
      const resultCellId = async (index: number): Promise<string> =>
        (await new PieceController(pieces, created[index]!.piece).result
          .getCell()).getAsNormalizedFullLink().id;
      // The token the parent wrote into the goal reached the child's
      // `run_pattern` as the seed pattern's live result cell.
      const childInput = created[1]?.input?.src;
      expect(isCell(childInput)).toBe(true);
      expect((childInput as Cell<unknown>).getAsNormalizedFullLink().id).toBe(
        await resultCellId(0),
      );
      // And the reference the child returned reached the parent's own
      // `run_pattern` as the child's result cell.
      const parentInput = created[2]?.input?.src;
      expect(isCell(parentInput)).toBe(true);
      expect((parentInput as Cell<unknown>).getAsNormalizedFullLink().id).toBe(
        await resultCellId(1),
      );
      const delegateOutput = chatViewOfRequest(requestBodies[4]).messages
        .filter((message) => message.role === "tool")
        .at(-1)?.content ?? "";
      expect(firstToken(delegateOutput)).toBeDefined();
      expect(delegateOutput).not.toContain("of:fid1:");
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });
});
