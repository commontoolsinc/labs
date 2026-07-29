/**
 * The llmDialog case whose delegate tool runs a child agent against a result
 * schema the model supplies in the tool input.
 *
 * This is split out of `llm-dialog.test.ts` and stays on the real clock, listed
 * in the preload's `REAL_CLOCK_FILES`, for the same reason as
 * `generate-object-tools-dynamic-subagent.test.ts`. The delegate tool awaits the
 * child pattern's result, and the tool-calling path guards that wait with its
 * own deadline. Because the schema arrives from the model rather than being
 * fixed when the pattern is written, the child cannot form its own request until
 * the tool input has been written into its inputs and the graph has settled, and
 * that round trip carries the delegate's completion across a macrotask boundary.
 * The fake clock's auto-advance pump reads that boundary as an idle event loop
 * and jumps logical time to the earliest pending production timer, which is the
 * deadline — so the delegate aborts with "Tool call timed out" while its child
 * is still in flight.
 *
 * The abort did not turn the case red. The conversation still reaches its third
 * request either way, so the closing assertion on the final message held while
 * the delegate that the case exists to exercise never completed. The case now
 * also asserts on the delegate's own tool result, so running it under the fake
 * clock again fails it rather than passing it quietly.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commonfabric/llm/client";
import type {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  JSONSchema,
} from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { Cell as RuntimeCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("llmDialog with a dynamic-schema subagent tool", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateObject"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      pattern,
      llmDialog,
      Cell,
      patternTool,
      generateObject,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should expose a userland subagent in llmDialog tool catalogs", async () => {
    const childResultSchema = {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["approved", "summary"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    loadConversationFixture({
      description: "llmDialog subAgent tool should be available to the parent",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["delegate"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_delegate",
              toolName: "delegate",
              input: {
                prompt: "analyze the hidden text",
                resultSchema: childResultSchema,
              },
            }],
            id: "dlg-subagent-r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["helperTool", "presentResult"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_child_present",
              toolName: "presentResult",
              input: {
                approved: false,
                summary: "Not approved.",
              },
            }],
            id: "dlg-subagent-r2",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["delegate"],
            messageCount: 3,
          },
          response: {
            role: "assistant",
            content: "Delegate completed.",
            id: "dlg-subagent-r3",
          },
        },
      ],
    });

    const helperTool = pattern(
      () => ({ ok: true }),
      {
        type: "object",
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const subAgentPattern = pattern<any, any>(
      ({ prompt, resultSchema }) => {
        return generateObject({
          prompt,
          schema: resultSchema,
          tools: {
            helperTool: patternTool(
              helperTool,
            ) as unknown as BuiltInLLMTool,
          },
        } as any).result;
      },
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          resultSchema: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["prompt", "resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            delegate: {
              description: "Run a child agent and return schema-limited JSON.",
              ...(patternTool(subAgentPattern) as unknown as BuiltInLLMTool),
            },
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-subagent-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Start the workflow." });

    await waitForMessages(runtime, result, 4);
    const messages = (await result.key("messages").pull())!;
    // The conversation reaches its third request whether the delegate returned
    // data or an error, so the closing assertion below cannot see an aborted
    // delegate. Assert on the tool result itself: a completed delegate reports
    // `{ type: "json", ... }`, one the clock aborted reports
    // `{ type: "error-text", value: "Tool call timed out" }`.
    const toolMessage = messages.find((message: any) =>
      message.role === "tool"
    );
    const delegateOutput = (toolMessage?.content as any[])?.find((part) =>
      part?.type === "tool-result" && part.toolName === "delegate"
    )?.output;
    expect(delegateOutput).toMatchObject({ type: "json" });
    expect(messages.at(-1)?.content).toBe("Delegate completed.");
  });
});

// `llm-dialog.test.ts` reaches this condition through a helper that rejects on a
// five-second deadline. The fake clock freezes that timer, so it has been inert
// there; on the real clock it would be live and would cap what the case can
// observe. `waitForCellValue` carries neither a deadline nor a poll interval,
// and applies its predicate only to a value read at quiescence rather than to
// one the sink reports mid-flight.
function waitForMessages(
  runtime: Runtime,
  // deno-lint-ignore no-explicit-any
  result: RuntimeCell<any>,
  expectedCount: number,
): Promise<unknown> {
  return waitForCellValue(
    runtime,
    result,
    // deno-lint-ignore no-explicit-any
    (value: any) =>
      value?.pending === false && value?.messages?.length === expectedCount,
  );
}
