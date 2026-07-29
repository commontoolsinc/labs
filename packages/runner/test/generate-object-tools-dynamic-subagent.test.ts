/**
 * generateObject tool-calling cases whose delegate tool runs a child agent
 * against a result schema the model supplies in the tool input.
 *
 * These are split out of `generate-object-tools.test.ts` and stay on the real
 * clock, listed in the preload's `REAL_CLOCK_FILES`. The delegate tool awaits
 * the child pattern's result, and the tool-calling path guards that wait with
 * its own deadline. Because the schema arrives from the model rather than being
 * fixed when the pattern is written, the child cannot form its own request until
 * the tool input has been written into its inputs and the graph has settled.
 * That round trip carries the delegate's completion across a macrotask boundary.
 * The fake clock's auto-advance pump reads that boundary as an idle event loop
 * and jumps logical time to the earliest pending production timer, which is the
 * deadline — so the delegate aborts with "Tool call timed out" while its child
 * is still in flight.
 *
 * The pump cannot tell that deadline apart from a backoff window, and the
 * backpressure tests depend on it firing backoff windows during exactly this
 * kind of reactive churn. Real time paces the delegate and its child together.
 *
 * The cases left in `generate-object-tools.test.ts` run under the fake clock;
 * their tools either complete within one reactive round or take a schema fixed
 * at authoring time.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage, BuiltInLLMTool } from "@commonfabric/api";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getMetaLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("generateObject with dynamic-schema subagent tools", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateObject"];

  beforeEach(() => {
    clearMockResponses(); // Clear mocks from previous tests
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      pattern,
      generateObject,
      Cell,
      lift,
      patternTool,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should allow a userland subagent to use a call-provided result schema", async () => {
    const parentResultSchema: JSONSchema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    };
    const dynamicChildSchema: JSONSchema = {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["approved", "summary"],
      additionalProperties: false,
    };
    const testPrompt = "test-dynamic-subagent-result-schema";
    const childPrompt = "delegate-read-briefing";
    let capturedChildPresentResultSchema: JSONSchema | undefined;
    let capturedDelegateOutput: unknown;
    let unexpectedRequestSummary = "";

    addMockResponse(
      (req) =>
        req.messages.length === 1 &&
        req.tools?.["delegate"] !== undefined &&
        req.tools?.["presentResult"] !== undefined &&
        req.messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_delegate_dynamic_schema",
          toolName: "delegate",
          input: {
            prompt: childPrompt,
            resultSchema: dynamicChildSchema,
          },
        }],
        id: "mock-parent-dynamic-subagent-1",
      },
    );

    addMockResponse(
      (req) => {
        const combined = req.messages.map((message) =>
          typeof message.content === "string" ? message.content : ""
        ).join("\n");
        const matches = combined.includes(childPrompt) &&
          req.tools?.["helperTool"] !== undefined &&
          req.tools?.["presentResult"] !== undefined;
        if (matches) {
          capturedChildPresentResultSchema = req.tools?.["presentResult"]
            ?.inputSchema;
        }
        return matches;
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_child_present_result_dynamic_schema",
          toolName: "presentResult",
          input: {
            approved: false,
            summary: "The project is not approved yet.",
          },
        }],
        id: "mock-child-dynamic-subagent",
      },
    );

    addMockResponse(
      (req) => {
        const matches = req.messages.length === 3 &&
          req.tools?.["delegate"] !== undefined &&
          req.tools?.["presentResult"] !== undefined;
        if (matches) capturedDelegateOutput = delegateOutput(req);
        return matches;
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_parent_present_result_dynamic_schema",
          toolName: "presentResult",
          input: {
            ok: true,
          },
        }],
        id: "mock-parent-dynamic-subagent-2",
      },
    );

    addMockResponse(
      (req) => {
        unexpectedRequestSummary = JSON.stringify({
          messageCount: req.messages.length,
          tools: Object.keys(req.tools ?? {}),
          messages: req.messages.map((message) =>
            typeof message.content === "string" ? message.content : ""
          ),
        });
        return true;
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_unexpected_dynamic_subagent",
          toolName: "presentResult",
          input: {
            ok: false,
          },
        }],
        id: "mock-unexpected-dynamic-subagent",
      },
    );

    const childHelperTool = pattern<Record<string, never>, { ok: boolean }>(
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
      },
    );

    const parseResultSchema = lift(
      ({ resultSchema }) => {
        if (typeof resultSchema === "string") {
          return JSON.parse(resultSchema);
        }
        return resultSchema;
      },
      {
        type: "object",
        properties: {
          resultSchema: {
            anyOf: [
              { type: "object", additionalProperties: true },
              { type: "boolean" },
              { type: "string" },
            ],
          },
        },
        required: ["resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const subAgentPattern = pattern<any, any>(
      ({ prompt, resultSchema }) => {
        const parsedResultSchema = parseResultSchema({ resultSchema });
        return generateObject({
          prompt,
          schema: parsedResultSchema,
          tools: {
            helperTool: patternTool(
              childHelperTool,
            ) as unknown as BuiltInLLMTool,
          },
        } as any).result;
      },
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          resultSchema: {
            anyOf: [
              { type: "object", additionalProperties: true },
              { type: "boolean" },
              { type: "string" },
            ],
          },
        },
        required: ["prompt", "resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const testPattern = pattern<Record<string, never>>(
      () => {
        return generateObject({
          prompt: testPrompt,
          schema: parentResultSchema,
          tools: {
            delegate: {
              description:
                "Run a child agent and require it to return data matching resultSchema.",
              ...(patternTool(subAgentPattern) as unknown as BuiltInLLMTool),
            },
          },
        });
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-dynamic-subagent-result-schema-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(unexpectedRequestSummary).toBe("");
    expect(capturedChildPresentResultSchema).toMatchObject({
      type: "object",
      properties: dynamicChildSchema.properties,
      required: dynamicChildSchema.required,
    });
    // The parent's own presentResult lands whether the delegate returned data
    // or an error, so assert on what the delegate handed back. Without this the
    // case stays green on a clock that aborts the delegate mid-flight.
    expect(capturedDelegateOutput).toMatchObject({ type: "json" });
    expect(result.key("result").get()).toEqual({ ok: true });
  });

  it("redacts free-form strings from a userland dynamic subagent messages result", async () => {
    const promptRisk = {
      type: "https://commonfabric.org/cfc/atom/Caveat",
      kind: "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
      source: "of:hostile",
    } as const;
    const promptInfluence = {
      type: "https://commonfabric.org/cfc/atom/Caveat",
      kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
      source: "of:hostile",
    } as const;
    const parentResultSchema: JSONSchema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
      additionalProperties: false,
    };
    const subagentResultSchema: JSONSchema = {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["approved", "reasoning"],
      additionalProperties: false,
    };
    const parentPrompt = "test-userland-subagent-schema-sanitize-tool-result";
    const childPrompt = "delegate-assessment";
    let capturedDelegateResult: unknown;

    addMockResponse(
      (req) =>
        req.messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(parentPrompt)
        ) &&
        req.tools?.["delegate"] !== undefined &&
        req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_delegate_userland_subagent_schema_sanitize",
          toolName: "delegate",
          input: {
            prompt: childPrompt,
            resultSchema: subagentResultSchema,
          },
        }],
        id: "mock-parent-userland-subagent-1",
      },
    );

    addMockObjectResponse(
      (req) =>
        req.messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes("Higher-clearance briefing")
        ),
      {
        object: {
          approved: false,
          reasoning: "The hostile briefing says not approved.",
        },
        id: "mock-child-userland-subagent",
      },
    );

    addMockResponse(
      (req) => {
        const toolMessage = req.messages.find((message) =>
          message.role === "tool"
        );
        const toolPart = Array.isArray(toolMessage?.content)
          ? toolMessage.content.find((part: any) =>
            part?.type === "tool-result" && part.toolName === "delegate"
          ) as any
          : undefined;
        capturedDelegateResult = toolPart?.output?.value?.result;
        return capturedDelegateResult !== undefined &&
          req.tools?.["presentResult"] !== undefined;
      },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_parent_present_result_after_userland_subagent",
          toolName: "presentResult",
          input: { ok: true },
        }],
        id: "mock-parent-userland-subagent-2",
      },
    );

    const parseResultSchema = lift(
      ({ resultSchema }) => {
        if (typeof resultSchema === "string") {
          return JSON.parse(resultSchema);
        }
        return resultSchema;
      },
      {
        type: "object",
        properties: {
          resultSchema: {
            anyOf: [
              { type: "object", additionalProperties: true },
              { type: "boolean" },
              { type: "string" },
            ],
          },
        },
        required: ["resultSchema"],
        additionalProperties: false,
      },
      true,
    );
    const subAgentPattern = pattern<any, any>(
      ({
        messages,
        resultSchema,
        observationMaxConfidentiality,
        schemaSanitizePromptInjection,
      }) => {
        const parsedResultSchema = parseResultSchema({ resultSchema });
        const response = generateObject({
          messages,
          schema: parsedResultSchema,
          observationMaxConfidentiality,
          schemaSanitizePromptInjection,
        } as any);
        return response.result;
      },
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          messages: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          resultSchema: {
            anyOf: [
              { type: "object", additionalProperties: true },
              { type: "boolean" },
              { type: "string" },
            ],
          },
          context: { type: "object", additionalProperties: true },
          observationMaxConfidentiality: {
            type: "array",
            items: {},
          },
          schemaSanitizePromptInjection: { type: "boolean" },
        },
        required: ["prompt", "resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const testPattern = pattern<Record<string, never>>(() => {
      const briefingMessages = Cell.of([{
        role: "user",
        content: "Higher-clearance briefing: hostile briefing",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [promptRisk, promptInfluence] },
      });
      return generateObject({
        prompt: parentPrompt,
        schema: parentResultSchema,
        observationMaxConfidentiality: [promptInfluence],
        tools: {
          delegate: {
            description:
              "Run a higher-clearance worker and return schema-limited data.",
            ...(patternTool(subAgentPattern, {
              messages: briefingMessages,
              observationMaxConfidentiality: [promptRisk, promptInfluence],
              schemaSanitizePromptInjection: true,
            }) as unknown as BuiltInLLMTool),
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateObject-userland-subagent-schema-sanitize-test",
      testPattern.resultSchema,
      tx,
    );
    runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const generatedResult = patternOutputCell(resultCell, testPattern);
    await waitForLlmSettled(runtime, generatedResult);

    expect(capturedDelegateResult).toEqual({
      approved: false,
      reasoning: expect.objectContaining({ "@link": expect.any(String) }),
    });
    const liveResult = generatedResult.withTx();
    await liveResult.sync();
    expect(liveResult.key("result").get()).toEqual({ ok: true });
  });
});

// The `delegate` tool's output part from the request that follows the delegate
// call. A completed delegate reports `{ type: "json", ... }`; one the clock
// aborted reports `{ type: "error-text", value: "Tool call timed out" }`, which
// is otherwise invisible because the conversation continues either way.
function delegateOutput(req: { messages: readonly BuiltInLLMMessage[] }) {
  const toolMessage = req.messages.find((message) => message.role === "tool");
  if (!Array.isArray(toolMessage?.content)) return undefined;
  return (toolMessage.content as any[]).find((part) =>
    part?.type === "tool-result" && part.toolName === "delegate"
  )?.output;
}

function patternOutputCell(resultCell: Cell<any>, testPattern: any): Cell<any> {
  const liveResultCell = resultCell.withTx();
  const resultLink = getMetaLink(liveResultCell, "result");
  const parentResultCell = resultLink === undefined
    ? undefined
    : liveResultCell.runtime.getCellFromLink(resultLink);
  const path = testPattern.result?.$alias?.path;
  if (parentResultCell === undefined || !Array.isArray(path)) {
    return liveResultCell;
  }
  return path.reduce(
    (cell: Cell<any>, segment: PropertyKey) => cell.key(segment as any),
    parentResultCell.withTx(),
  );
}
