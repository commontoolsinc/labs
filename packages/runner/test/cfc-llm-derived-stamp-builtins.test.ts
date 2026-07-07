import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import type { JSONSchema } from "../src/builder/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { LLM_DERIVED_RESULT_STAMP_SCHEMA } from "../src/builtins/llm-schemas.ts";

// Epic D1b (docs/plans/cfc-future-work-implementation.md): the `llm`,
// `generateText`, and `generateObject` builtins stamp their MODEL-OUTPUT
// writebacks with an explicit `LlmDerived` provenance atom — the same mark D1
// (cfc-llm-derived-stamp.test.ts) attaches to dialog messages. These tests are
// the D1b counterpart: for each builtin, real model output on the `result`
// field carries `LlmDerived`; a pattern-authored copy of the stamp is stripped
// by the runtime-minted evidence gate; and a `disabled` deployment is a no-op.

const signer = await Identity.fromPassphrase("runner-cfc-llm-derived-builtins");
const space = signer.did();

const LLM_DERIVED_ATOM = cfcAtom.llmDerived();

enableMockMode();

/** Flatten every integrity atom the persisted label surfaces at a cell. */
function integrityAtomsAt(cell: unknown): unknown[] {
  const view = cfcLabelViewForCell(cell);
  return (view?.entries ?? []).flatMap((entry) => entry.label.integrity ?? []);
}

/** The persisted integrity on a builtin's model-output `result` field. */
function resultIntegrity(result: Cell<any>): unknown[] {
  return integrityAtomsAt(result.key("result").resolveAsCell());
}

function waitForPendingToBecomeFalse(result: Cell<any>) {
  const liveResult = result.withTx();
  const timeoutMs = 5000;
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      await liveResult.sync();
      const pending = liveResult.key("pending").get() as unknown;
      if (pending === false) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timeout waiting for pending to become false"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick().catch(reject);
  });
}

describe("CFC LlmDerived stamping — result-field stamp mechanism", () => {
  // The builtins write model output through LLM_DERIVED_RESULT_STAMP_SCHEMA.
  // Prove the gate keys the stamp on the write's authoring identity at the
  // result field-path: a builtin write stamps, a pattern write is stripped.
  it("stamps a builtin write to the result field; strips a pattern write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      // Model-output write: builtin identity + the stamp schema at ["result"].
      const modelTx = runtime.edit();
      modelTx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "llm",
      });
      const builtinResult = runtime.getCell(
        space,
        "llm-derived-builtin-result",
        undefined,
        modelTx,
      );
      builtinResult.key("result").asSchema(LLM_DERIVED_RESULT_STAMP_SCHEMA).set(
        "model bytes",
      );
      modelTx.prepareCfc();
      expect((await modelTx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const builtinRead = runtime.getCell(
        space,
        "llm-derived-builtin-result",
        undefined,
        readTx,
      );
      expect(integrityAtomsAt(builtinRead.key("result"))).toContainEqual(
        LLM_DERIVED_ATOM,
      );
      readTx.commit();

      // Pattern write through the SAME stamp schema: no builtin identity, so
      // the runtime-minted gate strips the forged stamp.
      const forgeTx = runtime.edit();
      const forged = runtime.getCell(
        space,
        "llm-derived-forge-result",
        undefined,
        forgeTx,
      );
      forged.key("result").asSchema(LLM_DERIVED_RESULT_STAMP_SCHEMA).set(
        "forged provenance",
      );
      forgeTx.prepareCfc();
      expect((await forgeTx.commit()).ok).toBeDefined();

      const forgeReadTx = runtime.edit();
      const forgedRead = runtime.getCell(
        space,
        "llm-derived-forge-result",
        undefined,
        forgeReadTx,
      );
      expect(integrityAtomsAt(forgedRead.key("result"))).not.toContainEqual(
        LLM_DERIVED_ATOM,
      );
      forgeReadTx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("CFC LlmDerived stamping — llm builtins (end to end)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    clearMockResponses();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  it("stamps the `llm` builtin's model-output result", async () => {
    const testPrompt = "d1b-llm-stamp";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "hello from the model", id: "d1b-llm-1" },
    );

    const testPattern = builder.pattern(() =>
      builder.llm({ messages: [{ role: "user", content: testPrompt }] })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-llm-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateText` builtin's model-output result", async () => {
    const testPrompt = "d1b-generateText-stamp";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "text reply", id: "d1b-gt-1" },
    );

    const testPattern = builder.pattern(() =>
      builder.generateText({ prompt: testPrompt })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateText-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("result").get()).toBe("text reply");
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateObject` direct-path model-output result", async () => {
    const testPrompt = "d1b-generateObject-direct-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
      },
      required: ["title", "summary"],
    };
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.schema.type === "object",
      {
        object: { title: "Model Title", summary: "Model summary" },
        id: "d1b-go-direct-1",
      },
    );

    const testPattern = builder.pattern(() =>
      builder.generateObject({ prompt: testPrompt, schema: objectSchema })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-direct-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("result").get()).toEqual({
      title: "Model Title",
      summary: "Model summary",
    });
    // The custom user resultSchema does not itself declare LlmDerived; the stamp
    // is merged into its root at the write (withLlmDerivedStamp).
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateObject` tools-path model-output result", async () => {
    const testPrompt = "d1b-generateObject-tools-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    // A presentResult tool-call routes through the generateObject tools arm.
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_present_1",
          toolName: "presentResult",
          input: { verdict: "model-produced" },
        }],
        id: "d1b-go-tools-1",
      },
    );

    const dummyPattern = builder.pattern(() => ({}), { type: "object" });
    const testPattern = builder.pattern(() =>
      builder.generateObject({
        prompt: testPrompt,
        schema: objectSchema,
        tools: {
          dummy: {
            description: "forces the tool-calling path",
            pattern: dummyPattern,
          },
        },
      })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-tools-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("result").get()).toEqual({ verdict: "model-produced" });
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("does not stamp the `llm` result when CFC enforcement is disabled", async () => {
    const disabledStorage = StorageManager.emulate({ as: signer });
    const disabledRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: disabledStorage,
      cfcEnforcementMode: "disabled",
    });
    const disabledTx = disabledRuntime.edit();
    const { commonfabric } = createTrustedBuilder(disabledRuntime);

    const testPrompt = "d1b-llm-disabled";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "no stamp here", id: "d1b-llm-disabled-1" },
    );

    try {
      const testPattern = commonfabric.pattern(() =>
        commonfabric.llm({ messages: [{ role: "user", content: testPrompt }] })
      );
      const resultCell = disabledRuntime.getCell(
        space,
        "d1b-llm-disabled-result",
        testPattern.resultSchema,
        disabledTx,
      );
      const result = disabledRuntime.run(
        disabledTx,
        testPattern,
        {},
        resultCell,
      );
      disabledTx.commit();

      await expect(waitForPendingToBecomeFalse(result)).resolves
        .toBeUndefined();
      await disabledRuntime.idle();

      expect(resultIntegrity(result)).not.toContainEqual(LLM_DERIVED_ATOM);
    } finally {
      await disabledRuntime.idle();
      await disabledRuntime.dispose();
      await disabledStorage.close();
    }
  });
});
