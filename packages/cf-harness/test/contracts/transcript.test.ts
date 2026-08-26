import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type HarnessToolCall,
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
  isResumableHarnessTranscript,
} from "../../src/contracts/transcript.ts";
import { toResponsesInput } from "../../src/model/responses-protocol.ts";

const call = (id: string): HarnessToolCall => ({
  id,
  type: "function",
  function: { name: "read_file", arguments: "{}" },
});

const assistant = (
  content: string,
  ...toolCalls: HarnessToolCall[]
): HarnessTranscriptMessage => ({
  role: "assistant",
  content,
  ...(toolCalls.length > 0 ? { toolCalls } : {}),
});

const toolResult = (id: string): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId: id,
  toolName: "read_file",
  content: `contents for ${id}`,
});

const user = (content: string): HarnessTranscriptMessage => ({
  role: "user",
  content,
});

describe("harness transcript pairing", () => {
  it("accepts an empty transcript with a boundary of zero", () => {
    const pairing = inspectHarnessTranscriptPairing([]);
    expect(pairing.valid).toBe(true);
    expect(pairing.defects).toEqual([]);
    expect(pairing.safeBoundary).toBe(0);
  });

  it("accepts a fully paired transcript and puts the boundary at its end", () => {
    const transcript = [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      toolResult("a"),
      toolResult("b"),
      assistant("done"),
    ];
    const pairing = inspectHarnessTranscriptPairing(transcript);
    expect(pairing.valid).toBe(true);
    expect(pairing.safeBoundary).toBe(transcript.length);
  });

  it("reports both ids when an assistant declares two calls and neither is answered", () => {
    const transcript = [
      user("read both"),
      assistant("reading", call("a"), call("b")),
    ];
    const pairing = inspectHarnessTranscriptPairing(transcript);
    expect(pairing.valid).toBe(false);
    expect(pairing.defects).toEqual([
      {
        kind: "unresolved_tool_calls",
        messageIndex: 1,
        toolCallIds: ["a", "b"],
      },
    ]);
    expect(pairing.safeBoundary).toBe(1);
  });

  it("names only the unanswered id when one of two results has landed", () => {
    const transcript = [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      toolResult("a"),
    ];
    const pairing = inspectHarnessTranscriptPairing(transcript);
    expect(pairing.valid).toBe(false);
    expect(pairing.defects).toEqual([
      { kind: "unresolved_tool_calls", messageIndex: 1, toolCallIds: ["b"] },
    ]);
    expect(pairing.safeBoundary).toBe(1);
  });

  it("reports a tool result that no call preceded", () => {
    const pairing = inspectHarnessTranscriptPairing([
      user("hi"),
      toolResult("ghost"),
    ]);
    expect(pairing.defects).toEqual([
      { kind: "orphan_tool_result", messageIndex: 1, toolCallId: "ghost" },
    ]);
    // No truncation repairs an orphan, so the boundary stops before it.
    expect(pairing.safeBoundary).toBe(1);
  });

  it("reports a second result for a call that was already answered", () => {
    const pairing = inspectHarnessTranscriptPairing([
      assistant("reading", call("a")),
      toolResult("a"),
      toolResult("a"),
    ]);
    expect(pairing.defects).toEqual([
      { kind: "duplicate_tool_result", messageIndex: 2, toolCallId: "a" },
    ]);
    expect(pairing.safeBoundary).toBe(2);
  });

  it("reports a call id declared twice", () => {
    const pairing = inspectHarnessTranscriptPairing([
      assistant("reading", call("a")),
      toolResult("a"),
      assistant("again", call("a")),
    ]);
    expect(pairing.defects).toEqual([
      { kind: "duplicate_tool_call", messageIndex: 2, toolCallId: "a" },
    ]);
    // The prefix keeps the answered call and stops before the redeclaration.
    expect(pairing.safeBoundary).toBe(2);
  });

  it("accepts an assistant message carrying only native model tool results", () => {
    // These are provider-side results already embedded in the assistant
    // message. The Responses projection never turns them into a function_call,
    // so they need no matching tool message.
    const transcript: HarnessTranscriptMessage[] = [
      user("search"),
      {
        role: "assistant",
        content: "here is what I found",
        nativeModelToolResults: [
          {
            type: "cf-harness.native-model-tool-result",
            toolId: "google_search",
          },
        ],
      },
    ];
    const pairing = inspectHarnessTranscriptPairing(transcript);
    expect(pairing.valid).toBe(true);
    expect(pairing.safeBoundary).toBe(transcript.length);
  });

  it("keeps the boundary behind a user message that interleaves pending calls", () => {
    const transcript = [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      user("actually, never mind"),
    ];
    const pairing = inspectHarnessTranscriptPairing(transcript);
    expect(pairing.valid).toBe(false);
    expect(pairing.safeBoundary).toBe(1);
  });

  it("projects a transcript truncated at its boundary into paired provider input", async () => {
    // The boundary has to fall after a complete call/result pair, or the
    // projection below proves nothing about pairing.
    const transcript = [
      { role: "system", content: "Be careful." } as HarnessTranscriptMessage,
      user("read the first"),
      assistant("reading", call("a")),
      toolResult("a"),
      assistant("reading both", call("b"), call("c")),
      toolResult("b"),
    ];
    const { safeBoundary } = inspectHarnessTranscriptPairing(transcript);
    expect(safeBoundary).toBe(4);
    const rolledBack = transcript.slice(0, safeBoundary);
    expect(isResumableHarnessTranscript(rolledBack)).toBe(true);

    const { input } = await toResponsesInput(
      rolledBack,
      "gpt-5",
      "openai",
      "gateway Responses",
    );
    const calls = input.filter((item) => item.type === "function_call").map((
      item,
    ) => item.call_id);
    const outputs = input.filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id);
    expect(calls).toEqual(["a"]);
    // Every call has exactly one output and every output has its call: a bare
    // subset check passes on a transcript carrying neither.
    expect(outputs).toEqual(calls);
  });
});
