/**
 * What an interactive turn opens with.
 *
 * A turn is its own run with its own handle table, so the references that run
 * holds — the well-known grants of its space, the input cells the request
 * attached — have to be established and announced per turn. Without that a
 * console session had a fabric session it could not explore and no way to be
 * handed a cell at all, which is what these tests are about.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import type { HarnessInputCellSpec } from "../src/contracts/input-cells.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import type { CfHarnessEngine } from "../src/engine.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";

/**
 * An engine that reports what a fabric-configured run establishes, without
 * building a runtime or a sandbox to establish it against. What the service
 * does with the answers is the subject here; that the real engine mints those
 * tokens is `engine.test.ts`'s.
 */
const stubEngine = (
  established: { inputCells: readonly HarnessInputCellSpec[] },
): CfHarnessEngine =>
  ({
    config: { fabricSession: { space: "context-space" } },
    fabricSessionAvailable: true,
    establishWellKnownGrants: () =>
      Promise.resolve([{ name: "piece-registry", token: "cfh:a:grant" }]),
    establishInputCells: () =>
      Promise.resolve(
        established.inputCells.map((cell, index) => ({
          name: cell.name,
          ref: cell.ref,
          token: `cfh:a:cell${index}`,
        })),
      ),
  }) as unknown as CfHarnessEngine;

const recordingLoop = (
  seen: HarnessTranscriptMessage[][],
): HarnessInteractivePromptLoopFactory =>
() => ({
  runTranscript: (options: RunHarnessTranscriptOptions) => {
    seen.push([...options.transcript]);
    return Promise.resolve(
      {
        model: options.model ?? "gpt-test",
        finalAssistantText: "done",
        transcript: [
          ...options.transcript,
          { role: "assistant", content: "done" },
        ],
        modelTurns: 1,
      } as HarnessPromptLoopResult,
    );
  },
});

const runTurn = async (
  service: HarnessInteractiveChatService,
  turnId: string,
  text: string,
  inputCells?: readonly HarnessInputCellSpec[],
): Promise<void> => {
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: `req-${turnId}`,
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId,
      input: { text },
      ...(inputCells !== undefined ? { inputCells } : {}),
    },
  });
  await service.waitForTurn("session-1", turnId);
};

const startedService = async (
  seen: HarnessTranscriptMessage[][],
  established: { inputCells: readonly HarnessInputCellSpec[] },
): Promise<HarnessInteractiveChatService> => {
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: { engine: stubEngine(established) },
    createPromptLoop: recordingLoop(seen),
  });
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-session",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
    },
  });
  return service;
};

describe("interactive chat session context", () => {
  it("opens a turn with the granted references of its own space", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, { inputCells: [] });

    await runTurn(service, "turn-1", "what is in this space?");

    const context = seen[0].filter((message) =>
      message.role === "user" && message.content.includes("cfh:a:grant")
    );
    expect(context).toHaveLength(1);
    // Before the request it was established for, and after nothing.
    expect(seen[0].at(-1)?.content).toBe("what is in this space?");
  });

  it("announces the input cells the request attached, by the caller's names", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, {
      inputCells: [{ name: "itinerary", ref: "/of:fid1:x/days" }],
    });

    await runTurn(service, "turn-1", "summarize the trip", [
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);

    const announced = seen[0].find((message) =>
      message.content.includes("cfh:a:cell0")
    );
    expect(announced?.content).toContain("itinerary");
    // The token stands for the address; the address itself never crosses.
    expect(announced?.content).not.toContain("/of:fid1:x/days");
  });

  it("names cells per turn, so a following turn carries only its own", async () => {
    const options: (readonly HarnessInputCellSpec[] | undefined)[] = [];
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: { engine: stubEngine({ inputCells: [] }) },
      createPromptLoop: (loopOptions) => {
        options.push(loopOptions.inputCells);
        return recordingLoop([])(loopOptions);
      },
    });
    await service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-session",
      method: "start_session",
      params: {
        sessionId: "session-1",
        workspace: { hostPath: "/workspace" },
        model: "gpt-test",
      },
    });

    await runTurn(service, "turn-1", "summarize the trip", [
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);
    await runTurn(service, "turn-2", "and the cost?");

    expect(options[0]).toEqual([
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);
    expect(options[1]).toBeUndefined();
  });
});
