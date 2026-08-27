import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { kickoffRunHandles, kickoffRunSteps } from "../../kickoff/steps.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type { HarnessHandleTable } from "../../src/contracts/handle-table.ts";
import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";

const call = (
  id: string,
  name: string,
  args: unknown,
): HarnessTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});

const result = (
  toolCallId: string,
  toolName: string,
  content: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

describe("kickoff/steps", () => {
  describe("kickoffRunSteps()", () => {
    it("folds a tool call and its result into one step", () => {
      const steps = kickoffRunSteps([
        { role: "user", content: "do it" },
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok" }),
        { role: "assistant", content: "done" },
      ]);
      expect(steps.map((step) => step.kind)).toEqual([
        "user",
        "tool",
        "assistant",
      ]);
      expect(steps[1].input).toEqual({ sourceText: "x" });
      expect(steps[1].output).toEqual({ status: "ok" });
    });

    it("keeps an assistant message that carries text alongside its calls", () => {
      const steps = kickoffRunSteps([
        { role: "assistant", content: "thinking out loud", toolCalls: [] },
      ]);
      expect(steps).toHaveLength(1);
      expect(steps[0].text).toBe("thinking out loud");
    });

    it("reports arguments and results it cannot parse as text", () => {
      const steps = kickoffRunSteps([
        call("c1", "bash", "{not json"),
        result("c1", "bash", "plain output"),
      ]);
      expect(steps[0].input).toBeUndefined();
      expect(steps[0].inputText).toBe("{not json");
      expect(steps[0].output).toBeUndefined();
      expect(steps[0].outputText).toBe("plain output");
    });

    it("names the child a delegate_task step started", () => {
      const steps = kickoffRunSteps([
        call("c1", "delegate_task", { goal: "author it" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "run.subagent.1", status: "completed" },
        }),
      ]);
      expect(steps[0].childRunId).toBe("run.subagent.1");
    });

    it("reads a skill resource the tool says it read as an ok step", () => {
      const steps = kickoffRunSteps([
        call("c1", "read_skill_resource", { path: "SKILL.md" }),
        result("c1", "read_skill_resource", { status: "read", content: "#" }),
        call("c2", "read_skill_resource", { path: "logo.png" }),
        result("c2", "read_skill_resource", { status: "binary", bytes: 12 }),
        call("c3", "read_skill_resource", { path: "absent.md" }),
        result("c3", "read_skill_resource", { status: "error" }),
      ]);
      expect(steps.map((step) => step.status)).toEqual([
        "ok",
        "ok",
        "error",
      ]);
    });

    it("reads a skill script the tool says it executed as an ok step", () => {
      const steps = kickoffRunSteps([
        call("c1", "run_skill_script", { script: "build.sh" }),
        result("c1", "run_skill_script", { status: "executed", exitCode: 0 }),
      ]);
      expect(steps[0].status).toBe("ok");
    });

    it("reads a status no tool succeeds under as an error step", () => {
      const steps = kickoffRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { status: "compile-error" }),
        call("c2", "bash", { command: "ls" }),
        // `read` is a success only for the tool that reports it.
        result("c2", "bash", { status: "read" }),
      ]);
      expect(steps.map((step) => step.status)).toEqual(["error", "error"]);
    });

    it("brings a handle into scope at the step its token first appears", () => {
      const steps = kickoffRunSteps([
        { role: "user", content: "do it" },
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
        call("c2", "describe_handle", { handle: "cfh:a:aaaaa" }),
        result("c2", "describe_handle", { shape: "object" }),
        call("c3", "run_pattern", { inputs: { a: "cfh:a:aaaaa" } }),
        result("c3", "run_pattern", { resultRef: "cfh:a:bbbbb" }),
      ]);
      expect(steps[0].handlesInScope).toEqual([]);
      expect(steps[1].handlesIntroduced).toEqual(["cfh:a:aaaaa"]);
      // The second step only reads the handle, so it introduces nothing.
      expect(steps[2].handlesIntroduced).toEqual([]);
      expect(steps[2].handlesInScope).toEqual(["cfh:a:aaaaa"]);
      expect(steps[3].handlesIntroduced).toEqual(["cfh:a:bbbbb"]);
      expect(steps[3].handlesInScope).toEqual(["cfh:a:aaaaa", "cfh:a:bbbbb"]);
    });
  });

  describe("kickoffRunHandles()", () => {
    const table: HarnessHandleTable = {
      type: "cf-harness.handle-table",
      version: 1,
      salt: "run",
      entries: [
        {
          token: "cfh:a:aaaaa",
          kind: "address",
          ref: "/of:fid1:aaa",
          addressKey: '[null,"of:fid1:aaa","space",[]]',
        },
      ],
    };

    it("resolves a token against the run's own table", () => {
      const steps = kickoffRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
      ]);
      expect(kickoffRunHandles(steps, table)).toEqual([
        {
          token: "cfh:a:aaaaa",
          ref: "/of:fid1:aaa",
          addressKey: '[null,"of:fid1:aaa","space",[]]',
          introducedAtStep: 0,
        },
      ]);
    });

    it("still reports a token the table no longer holds", () => {
      const steps = kickoffRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:zzzzz" }),
      ]);
      const handles = kickoffRunHandles(steps, table);
      expect(handles).toHaveLength(1);
      expect(handles[0].token).toBe("cfh:a:zzzzz");
      expect(handles[0].ref).toBeUndefined();
    });
  });
});

describe("kickoff/steps CFC and disclosure", () => {
  const call = (
    id: string,
    name: string,
    args: unknown,
  ): HarnessTranscriptMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

  const result = (
    toolCallId: string,
    toolName: string,
    content: unknown,
  ): HarnessTranscriptMessage => ({
    role: "tool",
    toolCallId,
    toolName,
    content: JSON.stringify(content),
  });

  it("carries the CFC decision recorded for a call", () => {
    const steps = kickoffRunSteps(
      [
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { status: "ok" }),
      ],
      [
        {
          type: "cf-harness.policy-decision",
          sequence: 1,
          runId: "r",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          effectClass: "side-effect",
          cfcEnforcementMode: "enforce-explicit",
          decision: "allowed",
          reasonCodes: ["cfc_enforce_explicit_direct_command"],
        },
      ],
    );
    expect(steps[0].policy?.decision).toBe("allowed");
    expect(steps[0].policy?.effectClass).toBe("side-effect");
    expect(steps[0].status).toBe("ok");
  });

  it("reads a step as denied when a policy event denied its observation", () => {
    const steps = kickoffRunSteps(
      [
        call("c1", "bash", { command: "cat x" }),
        result("c1", "bash", { type: "cf-harness.observation-denied" }),
      ],
      [],
      [
        {
          type: "cf-harness.policy-event",
          severity: "denied",
          mode: "enforce-explicit",
          toolId: "bash",
          toolCallId: "c1",
          detail: "bash output did not include trusted CFC mediation metadata",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    expect(steps[0].status).toBe("denied");
    expect(steps[0].policyEvents).toHaveLength(1);
  });

  it("measures the longest numeric run a result let across as value", () => {
    const bytes = Array.from({ length: 40 }, (_, index) => index);
    const steps = kickoffRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", { status: "ok", value: { bytes } }),
    ]);
    expect(steps[0].disclosure?.longestNumericRun).toBe(40);
    expect(steps[0].disclosure?.sealedPositions).toBe(0);
  });

  it("counts a sealed position rather than reading it as a value", () => {
    const steps = kickoffRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", {
        status: "ok",
        value: { note: "opaque:handle/note" },
      }),
    ]);
    expect(steps[0].disclosure?.sealedPositions).toBe(1);
    expect(steps[0].disclosure?.longestNumericRun).toBe(0);
  });

  it("attaches the CFC invocation context recorded for the call's output", () => {
    const steps = kickoffRunSteps(
      [
        call("c1", "bash", { command: "ls" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "bash",
          content: JSON.stringify({ status: "ok" }),
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId: createToolOutputId("r", "bash", 2),
            toolId: "bash",
            runId: "r",
          },
        },
      ],
      [],
      [],
      [
        {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "bash",
          toolOutputId: createToolOutputId("r", "bash", 2),
          operation: "shell",
          cfcEnforcementMode: "enforce-explicit",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [
              {
                path: ["command"],
                label: {
                  confidentiality: [
                    {
                      type:
                        "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
                      version: 1,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    );
    expect(steps[0].invocation?.operation).toBe("shell");
    expect(steps[0].invocation?.cfcInputLabels?.entries[0].path).toEqual([
      "command",
    ]);
  });

  it("hands a context that named no output to its own tool's steps in turn", () => {
    const context = (
      sequence: number,
      toolId: string,
      cwd: string,
    ): HarnessCfcInvocationContext => ({
      type: "cf-harness.cfc-invocation-context",
      version: 1,
      sequence,
      runId: "r",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolId,
      operation: "shell",
      cfcEnforcementMode: "enforce-explicit",
      cwd,
      runManifest: { present: false },
      inputs: {},
    });
    const steps = kickoffRunSteps(
      [
        call("c1", "read_file", { path: "a.txt" }),
        result("c1", "read_file", { path: "a.txt", content: "a" }),
        call("c2", "read_file", { path: "b.txt" }),
        result("c2", "read_file", { path: "b.txt", content: "b" }),
      ],
      [],
      [],
      [
        context(1, "read_file", "/workspace/a"),
        context(
          2,
          "read_file",
          "/workspace/b",
        ),
      ],
    );
    expect(steps[0].invocation?.cwd).toBe("/workspace/a");
    expect(steps[1].invocation?.cwd).toBe("/workspace/b");
  });

  it("leaves a step with no invocation context recorded for another tool", () => {
    const steps = kickoffRunSteps(
      [
        call("c1", "read_file", { path: "a.txt" }),
        result("c1", "read_file", { path: "a.txt", content: "a" }),
      ],
      [],
      [],
      [
        {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "write_file",
          operation: "shell",
          cfcEnforcementMode: "enforce-explicit",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
        },
      ],
    );
    expect(steps[0].invocation).toBeUndefined();
  });

  it("measures a value in bytes rather than in code units", () => {
    const steps = kickoffRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", { status: "ok", value: { note: "🙂" } }),
    ]);
    // `{"note":"🙂"}` is thirteen code units and fifteen bytes.
    expect(steps[0].disclosure?.valueBytes).toBe(15);
  });

  it("leaves a step with no invocation context when none names its output", () => {
    const steps = kickoffRunSteps(
      [
        call("c1", "bash", { command: "ls" }),
        result("c1", "bash", { status: "ok" }),
      ],
      [],
      [],
      [],
    );
    expect(steps[0].invocation).toBeUndefined();
  });

  it("reports no disclosure for a result carrying no value at all", () => {
    const steps = kickoffRunSteps([
      call("c1", "assign_slug", { slug: "x" }),
      result("c1", "assign_slug", { status: "ok", slug: "x" }),
    ]);
    expect(steps[0].disclosure).toBeUndefined();
  });
});
