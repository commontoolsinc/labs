// The dialog's invalid-content branch: when a model reply carries nothing
// usable, an assistant error message is appended instead of the empty content.
// That branch had no end-to-end coverage, so nothing pinned either the message
// reaching `messages` or its landing in a document of its own -- the property
// the LlmDerived stamping downstream depends on.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  loadConversationFixture,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage } from "@commonfabric/api";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseLink } from "../src/link-utils.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";

const signer = await Identity.fromPassphrase("llm invalid content");

describe("llmDialog invalid model content", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
  });

  afterEach(async () => {
    clearMockResponses();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("appends an assistant error message, in its own document", async () => {
    // Empty content fails `hasValidContent()`, which is what selects the
    // branch under test.
    loadConversationFixture({
      description: "invalid content: empty assistant reply",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "", id: "empty-1" },
        },
      ],
    });

    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, llmDialog, Cell } = commonfabric;

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

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
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
      signer.did(),
      "llm-invalid-content",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Hello" });

    // The user message plus the substituted error message.
    await waitForLlmMessages(runtime, result, 2);

    const messagesCell = result.key("messages");
    const rtx = runtime.edit();
    const messages = messagesCell.withTx(rtx).get() as
      | readonly BuiltInLLMMessage[]
      | undefined;

    expect(messages?.length).toBe(2);
    const errorMessage = messages![1]!;
    expect(errorMessage.role).toBe("assistant");
    expect(String(errorMessage.content)).toContain(
      "I encountered an error generating a response",
    );

    // Its own document: the stored element is a link, which is exactly what
    // the LlmDerived stamping requires of every pushed message.
    for (const index of [0, 1]) {
      const raw = messagesCell.withTx(rtx).key(index).getRaw();
      const link = parseLink(raw);
      expect(link).not.toBe(undefined);
      expect(link?.id).not.toBe(undefined);
    }

    await rtx.commit();
  });
});
