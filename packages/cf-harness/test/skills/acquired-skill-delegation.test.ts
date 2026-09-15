/**
 * Delegates an acquired skill and drives script execution from the context
 * the child receives. The mount, tool, allowlist entry, and pin must all reach
 * the child for it to execute the script.
 */

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { DEFAULT_SUBAGENT_PROFILE } from "../../src/contracts/subagent.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { OpenAICompatibleGatewayClient } from "../../src/gateway/openai-client.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import { establishHarnessSessionContext } from "../../src/session-assembly.ts";
import { SkillsShAcquisitionClient } from "../../src/skills-sh/acquisition.ts";
import type { ProcessRunner } from "../../src/sandbox/process-runner.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "../support/responses-fixture.ts";

const OWNER = "commontoolsinc";
const REPO = "acquirable";
const SLUG = "budget";
const SKILL_ID = `${OWNER}/${REPO}/${SLUG}`;
const COMMIT_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const PIN = `${SKILL_ID}@${COMMIT_SHA}`;
const SCRIPT_PATH = "scripts/report.sh";
const SKILL_TEXT = "# Budget\n\nRun scripts/report.sh.\n";
const SCRIPT_TEXT = "#!/usr/bin/env bash\necho budgets\n";

const RAW = (path: string) =>
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/${COMMIT_SHA}/${path}`;

const githubFetch: typeof fetch = (input) => {
  const url = String(input);
  if (url === `https://api.github.com/repos/${OWNER}/${REPO}`) {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (url === `https://api.github.com/repos/${OWNER}/${REPO}/branches/main`) {
    return Promise.resolve(Response.json({ commit: { sha: COMMIT_SHA } }));
  }
  if (
    url ===
      `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${COMMIT_SHA}?recursive=1`
  ) {
    return Promise.resolve(Response.json({
      truncated: false,
      tree: [
        { path: SLUG, mode: "040000", type: "tree" },
        { path: `${SLUG}/SKILL.md`, mode: "100644", type: "blob" },
        { path: `${SLUG}/scripts`, mode: "040000", type: "tree" },
        { path: `${SLUG}/${SCRIPT_PATH}`, mode: "100755", type: "blob" },
      ],
    }));
  }
  if (url === RAW(`${SLUG}/SKILL.md`)) {
    return Promise.resolve(new Response(SKILL_TEXT));
  }
  if (url === RAW(`${SLUG}/${SCRIPT_PATH}`)) {
    return Promise.resolve(new Response(SCRIPT_TEXT));
  }
  return Promise.resolve(
    Response.json({ message: "Not Found" }, { status: 404 }),
  );
};

// The sandbox configuration is real so that the parent owns one and a child
// can be built from it, and this is what keeps the run off a container while
// that stays true: every `docker` invocation answers, so the sandbox behaves
// as configured without one existing. It is the configuration under test, not
// the container.
const scriptedDockerRunner: ProcessRunner = {
  run() {
    return Promise.resolve({
      stdout: "cf-harness-test-container\n",
      stderr: "",
      exitCode: 0,
    });
  },
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

/** What a scenario's scripted model turns are given, and may write back. */
interface AcquisitionScenarioContext {
  /** The handle `acquire_skill` returned, once the parent has read it. */
  handleToken: string;
  /** The pin the child's `<skill_context>` header carried, once delegated. */
  childPin?: string;
  /** Every URL the scenario's GitHub fetch was asked for, in order. */
  githubUrls: string[];
}

/**
 * Runs one parent with a real engine, a real sandbox configuration and a
 * scripted model, and hands the finished run to `assert`.
 *
 * The heavy half of one of these is the same every time — an emulated space,
 * an engine owning a sandbox configuration, and an acquisition client over the
 * captured GitHub responses — so what a scenario states is the two things that
 * differ: the operator's allowlist, and what the model does on each turn.
 */
const runAcquisitionScenario = async (options: {
  allowedSkillScripts: readonly { skill: string; path: string }[];
  turn: (
    index: number,
    body: { input?: { type?: string; output?: string }[] },
    context: AcquisitionScenarioContext,
  ) => unknown;
  assert: (
    engine: CfHarnessEngine,
    artifactRoot: string,
    context: AcquisitionScenarioContext,
  ) => Promise<void> | void;
}): Promise<void> => {
  const identity = await Identity.fromPassphrase(
    `acquired-delegation-${crypto.randomUUID()}`,
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });
  const pieces = new PiecesController(
    await createSession({
      identity,
      spaceName: `acquired-delegation-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  const artifactRoot = await Deno.makeTempDir({
    prefix: "acquired-delegation-",
  });
  const workspace = await Deno.makeTempDir({
    prefix: "acquired-delegation-workspace-",
  });
  const context: AcquisitionScenarioContext = {
    handleToken: "",
    githubUrls: [],
  };
  try {
    const engine = new CfHarnessEngine({
      runId: "acquired-delegation-run",
      artifactRoot,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
      processRunner: scriptedDockerRunner,
      sandbox: {
        dockerBinary: "docker",
        runtimeName: "runsc-cfc",
        image: "cf-harness:test",
        workspaceHostPath: workspace,
        workspaceMountPath: "/workspace",
        shellPath: "/bin/bash",
        dockerNetworkMode: "none",
        additionalMounts: [],
        extraDockerArgs: [],
      },
      allowedSkillScripts: options.allowedSkillScripts,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      skillsShAcquisitionClientFactory: () =>
        Promise.resolve(
          new SkillsShAcquisitionClient({
            fetch: (input, init) => {
              context.githubUrls.push(String(input));
              return githubFetch(input, init);
            },
          }),
        ),
    });

    let requests = 0;
    const modelFetch: typeof fetch = (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input?: { type?: string; output?: string }[];
      };
      const index = requests;
      requests += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            responsesBodyFromChatFixture(options.turn(index, body, context)),
          ),
          { status: 200 },
        ),
      );
    };

    const loop = new CfHarnessPromptLoop({
      engine,
      gatewayClient: new OpenAICompatibleGatewayClient({
        baseUrl: engine.config.gatewayBaseUrl,
        authMode: engine.config.gatewayAuthMode,
        apiKey: "test-key",
        transportRetries: 0,
        fetchFn: modelFetch,
      }),
      allowedToolIds: ["acquire_skill", "delegate_task"],
      allowedSubagentProfiles: [DEFAULT_SUBAGENT_PROFILE],
    });

    // Brought up the way every surface brings a session up, so what the
    // parent is told before its first turn is what a real run is told.
    const contextMessages = await establishHarnessSessionContext({
      engine,
      config: { skillNames: [] },
    });
    await loop.runPrompt({
      prompt: "Acquire the skill and delegate it.",
      contextMessages,
    });
    await options.assert(engine, artifactRoot, context);
  } finally {
    await Deno.remove(artifactRoot, { recursive: true });
    await Deno.remove(workspace, { recursive: true });
  }
};

/** Reads the handle out of the `acquire_skill` output the parent just saw. */
const handleFromOutput = (
  body: { input?: { type?: string; output?: string }[] },
): string => {
  const acquired = (body.input ?? []).findLast((entry) =>
    entry.type === "function_call_output"
  );
  return (JSON.parse(String(acquired?.output)) as { skillHandle: string })
    .skillHandle;
};

describe("delegating an acquired skill to a child", () => {
  it("tells the parent which pins its operator allowed scripts of", async () => {
    // The parent is the run that acquires, and a pin is the only thing that
    // makes the acquisition and the allowlist name the same bytes — so a run
    // never told the allowed pin can only acquire by name and hope.
    let openingContext = "";
    await runAcquisitionScenario({
      allowedSkillScripts: [
        { skill: PIN, path: SCRIPT_PATH },
        { skill: "agent-browser", path: "scripts/run.ts" },
      ],
      turn: (index, body) => {
        if (index === 0) {
          openingContext = chatViewOfRequest(body).messages
            .map((message) => message.content).join("\n");
        }
        return assistantTurn("Parent done.");
      },
      assert: () => {
        expect(openingContext).toContain(`- ${PIN} -> ${SCRIPT_PATH}`);
        expect(openingContext).toContain("- agent-browser -> scripts/run.ts");
        expect(openingContext).toContain("`acquire_skill` id");
      },
    });
  });

  it("acquires the exact commit an id pins, asking GitHub for no branch", async () => {
    // An operator's allowlist entry is keyed on a commit, so a run that
    // acquires by name gets the allowed bytes only when the default branch has
    // not moved. Naming the commit is what makes the two agree by construction.
    await runAcquisitionScenario({
      allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      turn: (index, body, context) => {
        if (index === 0) {
          return toolCallTurn("call-acquire", "acquire_skill", { id: PIN });
        }
        if (index === 1) {
          context.handleToken = handleFromOutput(body);
          return assistantTurn("Acquired.");
        }
        return assistantTurn("Parent done.");
      },
      assert: (engine, _artifactRoot, context) => {
        expect(engine.getRunState().acquiredSkills?.skills[0]?.pin).toBe(PIN);
        expect(context.githubUrls).not.toContain(
          `https://api.github.com/repos/${OWNER}/${REPO}`,
        );
        expect(context.githubUrls).not.toContain(
          `https://api.github.com/repos/${OWNER}/${REPO}/branches/main`,
        );
      },
    });
  });

  it("refuses the delegation naming both commits when the allowlist names another", async () => {
    // The child would otherwise receive no `run_skill_script` at all, which
    // reads exactly as an operator who allowed nothing — so the two commits
    // are said, and no child is spawned to hold a skill it cannot run.
    const otherPin = `${SKILL_ID}@${"1".repeat(40)}`;
    let delegateOutput = "";
    await runAcquisitionScenario({
      allowedSkillScripts: [{ skill: otherPin, path: SCRIPT_PATH }],
      turn: (index, body, context) => {
        if (index === 0) {
          return toolCallTurn("call-acquire", "acquire_skill", { id: PIN });
        }
        if (index === 1) {
          context.handleToken = handleFromOutput(body);
          return toolCallTurn("call-delegate", "delegate_task", {
            goal: "Use the acquired skill.",
            skillHandle: context.handleToken,
          });
        }
        if (index === 2) {
          delegateOutput = String(
            (body.input ?? []).findLast((entry) =>
              entry.type === "function_call_output"
            )?.output,
          );
          return assistantTurn("Parent done.");
        }
        return assistantTurn("Parent done.");
      },
      assert: (engine) => {
        expect(delegateOutput).toContain(otherPin);
        expect(delegateOutput).toContain(PIN);
        expect(delegateOutput).toContain("another commit");
        expect(engine.getRunState().subagentRuns ?? []).toHaveLength(0);
      },
    });
  });

  it("gives the child the mount, the tool, and only its own pin's entries", async () => {
    // Two entries, one for this pin and one for a skill this run never
    // acquired. A child that received both would be holding a decision the
    // operator made about something else.
    await runAcquisitionScenario({
      allowedSkillScripts: [
        { skill: PIN, path: SCRIPT_PATH },
        { skill: "some-other-skill", path: "scripts/other.sh" },
      ],
      turn: (index, body, context) => {
        if (index === 0) {
          return toolCallTurn("call-acquire", "acquire_skill", {
            id: SKILL_ID,
          });
        }
        if (index === 1) {
          context.handleToken = handleFromOutput(body);
          return toolCallTurn("call-delegate", "delegate_task", {
            goal: "Use the acquired skill.",
            skillHandle: context.handleToken,
          });
        }
        if (index === 2) {
          const childText = chatViewOfRequest(body).messages
            .map((message) => message.content).join("\n");
          context.childPin = /<skill_context\b[^>]*\bpin="([^"]+)"/.exec(
            childText,
          )?.[1];
          return toolCallTurn("call-script", "run_skill_script", {
            skill: context.childPin ?? "",
            path: SCRIPT_PATH,
          });
        }
        if (index === 3) {
          return assistantTurn("Child ran the script.");
        }
        return assistantTurn("Parent done.");
      },
      assert: async (engine, artifactRoot, context) => {
        expect(context.childPin).toBe(PIN);
        const acquired = engine.getRunState().acquiredSkills?.skills[0];
        expect(acquired?.pin).toBe(PIN);

        const child = engine.getRunState().subagentRuns?.[0];
        expect(child?.status).toBe("completed");

        // The tool, brought from the run to a profile that does not carry it.
        expect(child?.manifest.allowedToolIds).toContain("run_skill_script");
        // The operator's decision, narrowed to the skill this child was given.
        expect(child?.manifest.allowedSkillScripts).toEqual([
          { skill: PIN, path: SCRIPT_PATH },
        ]);

        // The mount, from the child's own record of the sandbox it was built.
        const capabilities = JSON.parse(
          await Deno.readTextFile(
            join(artifactRoot, child!.childRunId, "capabilities.json"),
          ),
        ) as {
          cfc?: { sandbox?: { cfc?: { mounts?: unknown[] } } };
        };
        expect(capabilities.cfc?.sandbox?.cfc?.mounts).toContainEqual({
          kind: "host-bind",
          name: "acquired-skill",
          hostPath: acquired!.hostRoot,
          sandboxPath: acquired!.sandboxRoot,
          readOnly: true,
          mode: "readonly",
        });

        // The child uses the pin from its context to run the mounted script
        // through the tool and the operator's allowlist.
        const executions = JSON.parse(
          await Deno.readTextFile(
            join(
              artifactRoot,
              child!.childRunId,
              "skill-script-executions.json",
            ),
          ),
        ) as {
          executions: {
            status: string;
            skillName: string;
            sandboxResourcePath?: string;
            acquisition?: { commitSha: string };
            error?: { code: string };
          }[];
        };
        expect(executions.executions).toHaveLength(1);
        const execution = executions.executions[0]!;
        expect(execution.error).toBeUndefined();
        expect(execution.status).toBe("executed");
        expect(execution.skillName).toBe(PIN);
        expect(execution.sandboxResourcePath).toBe(
          `/acquired-skill/${SCRIPT_PATH}`,
        );
        expect(execution.acquisition?.commitSha).toBe(COMMIT_SHA);
      },
    });
  });
});
