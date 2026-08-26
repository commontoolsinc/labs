/**
 * The `skillHandle` parameter on `delegate_task` (E5's consumption half): a
 * handle the PARENT holds, naming a cell whose string value is skill text
 * for the child. The text is materialized on the trusted host side at child
 * spawn and injected as a skill-context block, so the parent never reads it,
 * the child never holds the handle, and selection is by table membership
 * rather than by registry name.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
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

const SKILL_TEXT = [
  "# Trip planner skill",
  "",
  "CANARY-SKILL-9f4e2: always list flights before hotels.",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
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
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

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

const assistantTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

const scriptedFetch = (
  turns: readonly unknown[],
  requestBodies: unknown[],
): typeof fetch =>
(_input, init) => {
  requestBodies.push(JSON.parse(String(init?.body)));
  const turn = turns[requestBodies.length - 1] ??
    assistantTurn("Done.");
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
      status: 200,
    }),
  );
};

/** A fabric session over emulated storage with `SKILL_TEXT` seeded. */
const withSkillCell = async (
  body: (fixture: {
    pieces: PiecesController;
    ref: string;
  }) => Promise<void>,
): Promise<void> => {
  const signer = await Identity.fromPassphrase("skill-handle-delegation");
  const storageManager = StorageManager.emulate({ as: signer });
  const fabricRuntime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });
  const pieces = new PiecesController(
    await createSession({
      identity: signer,
      spaceName: `skill-handle-${crypto.randomUUID()}`,
    }),
    fabricRuntime,
  );
  await pieces.synced();
  try {
    const space = pieces.getSpace();
    const cell = fabricRuntime.getCell(space, "skill-cell", {} as const);
    const { error } = await fabricRuntime.editWithRetry((tx) => {
      cell.withTx(tx).set(SKILL_TEXT);
    });
    expect(error).toBeUndefined();
    await fabricRuntime.idle();
    const ref = createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);
    await body({ pieces, ref });
  } finally {
    await fabricRuntime.dispose();
    await storageManager.close();
  }
};

describe("prompt-loop delegate_task skillHandle", () => {
  it("materializes the handle into the child's skill context and never into the parent's", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle";
      const minted = await mintAddressHandle(
        createHarnessHandleTable(runId),
        ref,
      );
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces }),
      });
      await engine.recordHandleTable(minted.table);
      const requestBodies: unknown[] = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: scriptedFetch([
          delegateCallTurn("call-skill", {
            goal: "Plan the trip using the provided skill.",
            skillHandle: minted.token,
          }),
          assistantTurn("Trip planned per the skill."),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      expect(result.finalAssistantText).toBe(
        "Parent received the child summary.",
      );
      // The child's request carries the skill text inside a skill-context
      // block sourced from the handle token.
      const childRequest = chatViewOfRequest(requestBodies[1]);
      const childText = childRequest.messages.map((message) => message.content)
        .join("\n");
      expect(childText).toContain("CANARY-SKILL-9f4e2");
      expect(childText).toContain(
        `<skill_context source="handle:${minted.token}">`,
      );
      // The parent's requests never carry the skill text — the parent holds
      // the handle, not the payload.
      for (const index of [0, 2]) {
        const parentText = chatViewOfRequest(requestBodies[index]).messages
          .map((message) => message.content).join("\n");
        expect(parentText).not.toContain("CANARY-SKILL-9f4e2");
      }
      // One child ran for the delegation. Activation provenance (the
      // `skill-handle` source, token, digest, and absent registry paths) is
      // pinned by the `loadHarnessSkillContextFromText` unit tests.
      expect(result.runState.subagentRuns?.length).toBe(1);
    });
  });

  it("refuses a skillHandle this run does not hold, before any child exists", async () => {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-skill-handle-unknown",
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-skill-unknown", {
          goal: "Plan the trip.",
          skillHandle: "cfh:a:qqqqq",
        }),
        assistantTurn("Understood, no such reference."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the plan." });

    // The refusal is a recoverable invalid-tool-call the model reacts to; no
    // subagent run was created for it.
    const toolMessage = result.transcript.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("cf-harness.invalid-tool-call");
    expect(toolMessage?.content).toContain("skillHandle");
    expect(result.runState.subagentRuns ?? []).toEqual([]);
  });
});
