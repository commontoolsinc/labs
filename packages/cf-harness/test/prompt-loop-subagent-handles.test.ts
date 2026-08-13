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
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
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
        bashCallTurn("call-child", `cf get ${token}`),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const command = dispatchedCommand(sandbox, "cf get ");
    expect(command).toContain(`cf get ${table.entries[0]!.ref}`);
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
        bashCallTurn("call-child", `cf get ${sharedToken} ${withheldToken}`),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const command = dispatchedCommand(sandbox, "cf get ");
    expect(command).toContain(table.entries[0]!.ref);
    expect(command).toContain(withheldToken);
    expect(command).not.toContain(HASH_B);
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
          `cf get ${firstToken(lastToolContent(3))}`,
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
    const command = dispatchedCommand(sandbox, "cf get ");
    expect(command).toContain(
      `cf get ${result.runState.handleTable?.entries[0]?.ref}`,
    );
    expect(command).not.toContain(parentTokenC);
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
});
