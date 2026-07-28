/**
 * Cancelling a dialog turn has to reach a tool call that is still running.
 *
 * A turn is aborted when the durable `pending` cell goes false — which is what
 * `cancelGeneration` does, so the effect reaches every replica — or when a newer
 * request supersedes it. That abort used to reach only the model call: the tool
 * path took no signal, so a tool that was mid-run carried on to its own
 * deadline, and only its writeback was discarded. The work was never stopped.
 *
 * Here the model's first answer calls a tool, and the turn is cancelled while
 * that call is in progress. The tool reports the cancellation, the runtime
 * settles, and logical time has not jumped the tool-call deadline.
 *
 * What this does NOT pin: that the abort ends a tool call which would otherwise
 * never finish. Doing that needs a pattern tool whose result cell genuinely
 * stays undefined, and the obvious spellings do not — a pattern returning `{}`
 * or `undefined` still leaves the cell defined, so the wait ends on its own and
 * the abort is never the thing that freed it. Until such a fixture exists, the
 * race participant is covered by inspection rather than by this test; the
 * cancellation reporting and the run being stopped are covered here.
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
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

describe("cancelling a dialog turn stops a running tool", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, llmDialog, Cell, patternTool } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("settles the turn instead of waiting out the tool", async () => {
    loadConversationFixture({
      description: "one tool call, into a tool that never returns",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { hasTools: ["stall"], messageCount: 1 },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_stall",
              toolName: "stall",
              input: {},
            }],
            id: "cancel-r1",
          },
        },
      ],
    });

    // A tool whose pattern writes no result at all, so its result cell never
    // becomes defined and the tool call waits. Returning `{}` would not do: an
    // empty object is a value, the cell becomes defined, and the wait ends at
    // once. Before cancellation reached the tool path, only the deadline ended
    // this.
    const stallTool = pattern<Record<string, never>, undefined>(
      () => undefined,
      { type: "object", additionalProperties: false },
      true,
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        cancelGeneration: { type: "object", asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            stall: {
              description: "Never returns a result.",
              ...(patternTool(stallTool) as unknown as BuiltInLLMTool),
            },
          },
        });
        return {
          addMessage: dialog.addMessage,
          cancelGeneration: dialog.cancelGeneration,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-tool-cancel-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Start the stalling tool." });

    // Wait until the turn is actually running, so the cancel lands while the
    // tool call is outstanding rather than before it starts.
    await waitForCellValue(
      runtime,
      result,
      (value: any) => value?.pending === true,
    );

    const cancelGeneration = await result.key("cancelGeneration").pull();
    const before = Date.now();
    cancelGeneration.send({});

    // `pending` is not the thing to wait on: `cancelGeneration` writes it false
    // itself, so it flips whether or not the tool call heard anything. Wait for
    // the runtime to settle, which spans the dialog turn's promise and so spans
    // the outstanding tool call inside it.
    await runtime.settled();
    expect(result.withTx().key("pending").get()).toBe(false);

    // Logical time must not have jumped the tool-call deadline: under the fake
    // clock a turn that ended by waiting the deadline out reaches rest just as
    // quickly in real time, and the 120-second jump is what tells them apart.
    expect(Date.now() - before).toBeLessThan(120_000);
  });
});
