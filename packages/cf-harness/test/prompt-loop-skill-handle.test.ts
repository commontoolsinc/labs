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
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type { PromptSlotBinding } from "../src/contracts/prompt-slot.ts";

const directPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "direct-test" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "direct-test",
  eventId: "event-direct",
};

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

/** A fabric session over emulated storage with `text` seeded. */
const withSkillCell = async (
  body: (fixture: {
    pieces: PiecesController;
    ref: string;
  }) => Promise<void>,
  text: string = SKILL_TEXT,
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
      cell.withTx(tx).set(text);
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
    // A fabric session exists and the run HOLDS a table — just not this
    // token — so the refusal under test is table membership itself, not the
    // earlier no-session arm.
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-unknown";
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
          delegateCallTurn("call-skill-unknown", {
            goal: "Plan the trip.",
            skillHandle: "cfh:a:qqqqq",
          }),
          assistantTurn("Understood, no such reference."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({
        prompt: "Delegate the plan.",
        promptSlotBinding: directPromptSlotBinding,
      });

      // The refusal is a recoverable invalid-tool-call the model reacts to;
      // no subagent run was created for it.
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("cf-harness.invalid-tool-call");
      expect(toolMessage?.content).toContain(
        "does not name a handle this run holds",
      );
      expect(result.runState.subagentRuns ?? []).toEqual([]);
    });
  });

  it("scrubs a child that echoes the skill text back, on the plain summary path", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-echo";
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
          delegateCallTurn("call-skill-echo", {
            goal: "Plan the trip using the provided skill.",
            skillHandle: minted.token,
          }),
          // A naive child repeats its instructions verbatim.
          assistantTurn(`Here is what I was told:\n${SKILL_TEXT}`),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      // The payload never crosses as itself: the parent's third request (the
      // one carrying the delegate tool output) holds the scrub marker, not
      // the canary.
      const parentText = chatViewOfRequest(requestBodies[2]).messages
        .map((message) => message.content).join("\n");
      expect(parentText).not.toContain("CANARY-SKILL-9f4e2");
      expect(parentText).toContain("skill text withheld");
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("CANARY-SKILL-9f4e2");
    });
  });

  it("scrubs an echo inside a structured return string", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-echo-structured";
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
          delegateCallTurn("call-skill-echo-json", {
            goal: "Plan the trip using the provided skill.",
            skillHandle: minted.token,
            returnSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
            },
          }),
          // The child returns JSON whose string value embeds the payload —
          // the JSON-escaped spelling of the skill text.
          assistantTurn(JSON.stringify({ note: `stole: ${SKILL_TEXT}` })),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      const parentText = chatViewOfRequest(requestBodies[2]).messages
        .map((message) => message.content).join("\n");
      expect(parentText).not.toContain("CANARY-SKILL-9f4e2");
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("CANARY-SKILL-9f4e2");
    });
  });

  it("scrubs an echo hidden behind non-canonical JSON escapes", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-echo-escapes";
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
      // Every character spelled as a \uXXXX escape: a valid JSON encoding of
      // the payload that no substring scrub of the serialized text can
      // match, and that JSON.parse decodes straight back to the canary.
      const evasiveEscapes = [...SKILL_TEXT].map((char) =>
        `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`
      ).join("");
      const requestBodies: unknown[] = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: scriptedFetch([
          delegateCallTurn("call-skill-escapes", {
            goal: "Plan the trip using the provided skill.",
            skillHandle: minted.token,
            returnSchema: {
              type: "object",
              properties: {
                note: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                count: { type: "number" },
              },
              required: ["note", "tags", "count"],
            },
          }),
          assistantTurn(
            `{"note": "stole: ${evasiveEscapes}", "tags": ["${evasiveEscapes}"], "count": 2}`,
          ),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      const parentText = chatViewOfRequest(requestBodies[2]).messages
        .map((message) => message.content).join("\n");
      expect(parentText).not.toContain("CANARY-SKILL-9f4e2");
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("CANARY-SKILL-9f4e2");
    });
  });

  it("scrubs a payload that embeds a token the delegation also seeded", async () => {
    // The skill text CONTAINS a token the goal names, so the child's table
    // resolves that substring to an address inside the echo. Scrubbing after
    // resolution would no longer match the payload; the scrub runs on the
    // raw text first.
    const signer = await Identity.fromPassphrase("skill-handle-token-embed");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `skill-handle-embed-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const space = pieces.getSpace();
      const runId = "run-skill-handle-token-embed";
      const dataCell = fabricRuntime.getCell(space, "data-cell", {} as const);
      const skillCell = fabricRuntime.getCell(space, "skill-cell", {} as const);
      const seedData = await fabricRuntime.editWithRetry((tx) => {
        dataCell.withTx(tx).set("plain data");
      });
      expect(seedData.error).toBeUndefined();
      const dataRef = createLLMFriendlyLink(
        dataCell.getAsNormalizedFullLink(),
        space,
      );
      let table = createHarnessHandleTable(runId);
      const mintedData = await mintAddressHandle(table, dataRef);
      table = mintedData.table;
      const skillText = [
        "# Trip planner skill",
        "",
        `CANARY-SKILL-9f4e2: read ${mintedData.token} before planning.`,
      ].join("\n");
      const seedSkill = await fabricRuntime.editWithRetry((tx) => {
        skillCell.withTx(tx).set(skillText);
      });
      expect(seedSkill.error).toBeUndefined();
      await fabricRuntime.idle();
      const skillRef = createLLMFriendlyLink(
        skillCell.getAsNormalizedFullLink(),
        space,
      );
      const mintedSkill = await mintAddressHandle(table, skillRef);
      table = mintedSkill.table;
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces }),
      });
      await engine.recordHandleTable(table);
      const requestBodies: unknown[] = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: scriptedFetch([
          delegateCallTurn("call-skill-embed", {
            goal: `Plan the trip; the data is ${mintedData.token}.`,
            skillHandle: mintedSkill.token,
          }),
          // The child echoes the skill verbatim, embedded token included.
          assistantTurn(`Here is what I was told:\n${skillText}`),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      const parentText = chatViewOfRequest(requestBodies[2]).messages
        .map((message) => message.content).join("\n");
      expect(parentText).not.toContain("CANARY-SKILL-9f4e2");
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("CANARY-SKILL-9f4e2");
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a skillHandle when the run has no fabric session", async () => {
    const runId = "run-skill-handle-no-session";
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-skill-no-session", {
          goal: "Plan the trip.",
          skillHandle: "cfh:a:qqqqq",
        }),
        assistantTurn("Understood."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the plan." });

    const toolMessage = result.transcript.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("cf-harness.invalid-tool-call");
    expect(toolMessage?.content).toContain("requires a fabric session");
    expect(result.runState.subagentRuns ?? []).toEqual([]);
  });

  it("refuses a skillHandle that is not a non-empty string", async () => {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-skill-handle-bad-shape",
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        delegateCallTurn("call-skill-bad-shape", {
          goal: "Plan the trip.",
          skillHandle: 42,
        }),
        assistantTurn("Understood."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the plan." });

    const toolMessage = result.transcript.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("cf-harness.invalid-tool-call");
    expect(toolMessage?.content).toContain(
      "a non-empty handle string, or omit it",
    );
    expect(result.runState.subagentRuns ?? []).toEqual([]);
  });

  it("refuses a handle naming empty skill text", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-empty";
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
          delegateCallTurn("call-skill-empty", {
            goal: "Plan the trip.",
            skillHandle: minted.token,
          }),
          assistantTurn("Understood."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("cf-harness.invalid-tool-call");
      expect(toolMessage?.content).toContain(
        "a handle naming non-empty skill text",
      );
      expect(result.runState.subagentRuns ?? []).toEqual([]);
    }, "   \n\t");
  });

  it("scrubs a one-line payload whose raw and JSON-escaped spellings coincide", async () => {
    const oneLine = "CANARY-SKILL-9f4e2 one-line skill with no escapes";
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-one-line";
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
          delegateCallTurn("call-skill-one-line", {
            goal: "Plan the trip using the provided skill.",
            skillHandle: minted.token,
          }),
          assistantTurn(`Repeating: ${oneLine}`),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      const result = await loop.runPrompt({ prompt: "Delegate the plan." });

      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("CANARY-SKILL-9f4e2");
      expect(result.runState.subagentRuns?.length).toBe(1);
    }, oneLine);
  });

  it("records the table token on the activation when the handle is passed as a reference", async () => {
    await withSkillCell(async ({ pieces, ref }) => {
      const runId = "run-skill-handle-ref-spelling";
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
          delegateCallTurn("call-skill-ref", {
            goal: "Plan the trip using the provided skill.",
            // The REFERENCE spelling of the same handle: still resolved
            // through the table, and the child's block carries the TOKEN.
            skillHandle: ref,
          }),
          assistantTurn("Trip planned per the skill."),
          assistantTurn("Parent received the child summary."),
        ], requestBodies),
      });

      await loop.runPrompt({ prompt: "Delegate the plan." });

      const childText = chatViewOfRequest(requestBodies[1]).messages
        .map((message) => message.content).join("\n");
      expect(childText).toContain(
        `<skill_context source="handle:${minted.token}">`,
      );
    });
  });
});
