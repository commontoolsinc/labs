/**
 * End-to-end custody for externally acquired skill text: acquisition returns
 * a handle to the parent, delegation materializes it only in the child, and
 * the existing echo scrub prevents the child from returning it.
 */

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { SkillsShAcquisitionClient } from "../src/skills-sh/acquisition.ts";
import { SkillsShSearchClient } from "../src/skills-sh/search-client.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import membraneTree from "./skills-sh/fixtures/membranedev-application-skills-f484c.tree.json" with {
  type: "json",
};

const COMMIT_SHA = "f484c8265e70ec910a57342389cca5c5de7d8167";
const SKILL_ID = "membranedev/application-skills/plaid";
const SKILL_URL =
  `https://raw.githubusercontent.com/membranedev/application-skills/${COMMIT_SHA}/skills/plaid/SKILL.md`;
const CANARY = "EXTERNAL-SKILL-CANARY-34f28";
const SKILL_TEXT =
  `# External skill\n\n${CANARY}: keep this secret from the parent.\n`;

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

const githubFetch: typeof fetch = (input) => {
  const url = String(input);
  if (url === "https://api.github.com/repos/membranedev/application-skills") {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (
    url ===
      "https://api.github.com/repos/membranedev/application-skills/branches/main"
  ) {
    return Promise.resolve(Response.json({ commit: { sha: COMMIT_SHA } }));
  }
  if (
    url ===
      `https://api.github.com/repos/membranedev/application-skills/git/trees/${COMMIT_SHA}?recursive=1`
  ) {
    return Promise.resolve(Response.json(membraneTree));
  }
  if (url === SKILL_URL) return Promise.resolve(new Response(SKILL_TEXT));
  return Promise.resolve(
    Response.json({ message: "Not Found" }, { status: 404 }),
  );
};

const toolCallTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const assistantTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

describe("prompt-loop external skill acquisition", () => {
  it("withholds acquire_skill unless both configuration and fabric are present", async () => {
    const base = {
      sandboxRuntime: new FakeSandboxRuntime(),
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled" as const,
    };
    const engines = [
      new CfHarnessEngine({
        ...base,
        skillsShAcquisitionClientFactory: () =>
          Promise.resolve(
            new SkillsShAcquisitionClient({ fetch: githubFetch }),
          ),
      }),
      new CfHarnessEngine({
        ...base,
        fabricSessionFactory: () => Promise.reject(new Error("unused")),
      }),
    ];

    for (const engine of engines) {
      let request: unknown;
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        allowedToolIds: ["acquire_skill"],
        fetchFn: (_input, init) => {
          request = JSON.parse(String(init?.body));
          return Promise.resolve(
            new Response(JSON.stringify(
              responsesBodyFromChatFixture(assistantTurn("done")),
            )),
          );
        },
      });

      await loop.runPrompt({ prompt: "Try acquisition." });

      expect(chatViewOfRequest(request).tools).not.toContain("acquire_skill");
    }
  });

  it("keeps acquired text out of every parent request and return", async () => {
    const identity = await Identity.fromPassphrase(
      `external-skill-canary-${crypto.randomUUID()}`,
    );
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "disabled",
      cfcFlowLabels: "off",
    });
    const pieces = new PiecesController(
      await createSession({
        identity,
        spaceName: `external-skill-canary-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "external-skill-canary-run",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces }),
        skillsShSearchClientFactory: () =>
          Promise.resolve(
            new SkillsShSearchClient({
              origin: "https://registry.example",
              fetch: () => Promise.resolve(Response.json({ skills: [] })),
            }),
          ),
        skillsShAcquisitionClientFactory: () =>
          Promise.resolve(
            new SkillsShAcquisitionClient({ fetch: githubFetch }),
          ),
      });
      const requestBodies: unknown[] = [];
      let handleToken = "";
      const modelFetch: typeof fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requestBodies.push(body);
        const index = requestBodies.length - 1;
        const view = chatViewOfRequest(body);
        let turn: unknown;
        if (index === 0) {
          expect(view.tools).toContain("acquire_skill");
          turn = toolCallTurn("call-acquire", "acquire_skill", {
            id: SKILL_ID,
          });
        } else if (index === 1) {
          const toolMessage = view.messages.findLast((message) =>
            message.role === "tool"
          );
          expect(toolMessage?.content).not.toContain(CANARY);
          const output = JSON.parse(toolMessage!.content) as {
            skillHandle: string;
          };
          handleToken = output.skillHandle;
          expect(handleToken).toMatch(/^cfh:a:/);
          turn = toolCallTurn("call-delegate", "delegate_task", {
            goal: "Use the acquired instructions.",
            skillHandle: handleToken,
          });
        } else if (index === 2) {
          const childText = view.messages.map((message) => message.content)
            .join(
              "\n",
            );
          expect(childText).toContain(CANARY);
          expect(childText).toContain(
            `<skill_context source="handle:${handleToken}">`,
          );
          turn = assistantTurn(`Attempted echo:\n${SKILL_TEXT}`);
        } else {
          const parentText = view.messages.map((message) => message.content)
            .join(
              "\n",
            );
          expect(parentText).not.toContain(CANARY);
          turn = assistantTurn("Parent completed without seeing skill text.");
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: modelFetch,
        allowedToolIds: ["acquire_skill", "delegate_task"],
      });

      const result = await loop.runPrompt({
        prompt: "Acquire and delegate to the Plaid skill.",
      });

      expect(result.finalAssistantText).toBe(
        "Parent completed without seeing skill text.",
      );
      expect(result.finalAssistantText).not.toContain(CANARY);
      for (const index of [0, 1, 3]) {
        const parentText = chatViewOfRequest(requestBodies[index]).messages
          .map((message) => message.content).join("\n");
        expect(parentText).not.toContain(CANARY);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
