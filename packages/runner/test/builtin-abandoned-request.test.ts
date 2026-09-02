/**
 * What a builtin leaves behind when the transaction staging its request is
 * abandoned.
 *
 * Each of these stages its request in the transaction that schedules the work
 * and does the work once that transaction commits, so an abandoned one means
 * the request is never sent. The settled shape differs per builtin, but the
 * property is the same everywhere: the result cells the pattern reads are
 * announced and say the request will not be answered, rather than staying as
 * they were with nothing coming.
 *
 * The last block is the control the rest of the file rests on: the same
 * builtins over an input the result store admits, where the staging
 * transaction commits and the request is sent. Without it the cases above
 * would hold of a builtin that never sends anything at all.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";

import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { Cell } from "../src/builder/types.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { Runtime } from "../src/runtime.ts";
import { MAX_ENFORCEMENT_CFC_OPTIONS } from "../src/runtime-presets.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// A caveat the result store does not declare. The builtin reads the input
// carrying it, so its writes derive that confidentiality, and the undeclared
// store resolves to the empty ceiling — the writer-fit misfit, which rejects
// at `enforce-strict`.
const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

describe("a builtin whose staged request is abandoned", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      // The bundle pins every staged dial; the enforcement mode is the
      // per-session raise on top of it, and the bundle's persisted flow labels
      // are what make that raise conform.
      cfcEnforcementMode: "enforce-strict",
    });
    tx = runtime.edit();
    ({ commonfabric } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Resolve once the cell reports an error, at a quiescent moment. */
  // deno-lint-ignore no-explicit-any
  function waitForError(cell: Cell<any>): Promise<{ error?: string }> {
    return waitForCellValue<{ error?: string }>(
      runtime,
      cell,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
  }

  it("reports the refusal on streamData's error cell", async () => {
    const { pattern, streamData, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const url = BuilderCell.of("https://example.invalid/events", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return streamData({ url } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "streamData-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    // The rule's own reason names the document it matched on and the source of
    // each caveat, which the pattern-facing surface withholds.
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on generateObject's error cell with no tools", async () => {
    // The tools path and the direct path build and settle their requests
    // separately, so a request with no tools reaches the second of them.
    const { pattern, generateObject, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const messages = BuilderCell.of([{
        role: "user",
        content: "a briefing the result store does not declare",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      return generateObject({
        messages,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "generateObject-direct-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on generateObject's error cell with tools", async () => {
    // The tools path stages its own request, separately from the direct one
    // the case above reaches, and settles through its own ending.
    const { pattern, generateObject, Cell: BuilderCell } = commonfabric;
    const dummyPattern = pattern<Record<string, never>, { ok: boolean }>(
      () => ({
        ok: true,
      }),
    );
    const testPattern = pattern<Record<string, never>>(() => {
      const messages = BuilderCell.of([{
        role: "user",
        content: "a briefing the result store does not declare",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      return generateObject({
        messages,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        tools: {
          dummy: {
            description: "a tool, so the request takes the tool-calling path",
            pattern: dummyPattern,
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "generateObject-tools-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on generateText's error cell", async () => {
    const { pattern, generateText, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const messages = BuilderCell.of([{
        role: "user",
        content: "a briefing the result store does not declare",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return generateText({ messages } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "generateText-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on llm's error cell", async () => {
    const { pattern, llm, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const messages = BuilderCell.of([{
        role: "user",
        content: "a briefing the result store does not declare",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return llm({ messages } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "llm-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on fetchProgram's error cell", async () => {
    const { pattern, fetchProgram, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const url = BuilderCell.of("https://example.invalid/program.js", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return fetchProgram({ url } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "fetchProgram-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    // A run derives these cells from its cache entry, and an abandoned
    // request has no following run to do it.
    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on fetchJson's error cell", async () => {
    const { pattern, fetchJson, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const url = BuilderCell.of("https://example.invalid/data.json", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return fetchJson({ url } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "fetchJson-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("reports the refusal on sqliteQuery's result cell", async () => {
    // The database handle is a value rather than a builtin's output, so the
    // only transaction here is the one staging the query, and the refusal
    // lands on that.

    const { pattern, sqliteQuery, Cell: BuilderCell } = commonfabric;
    const db: SqliteDbRef = {
      id: "of:abandoned-query-db",
      tables: { notes: table({ id: "integer primary key" }) },
    };
    const testPattern = pattern<Record<string, never>>(() => {
      const sql = BuilderCell.of("SELECT id FROM notes", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return sqliteQuery({ db, sql } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "sqliteQuery-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForError(result);
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("takes llmDialog's pending flag down when the turn is refused", async () => {
    // The turn is staged inside the handler that appends the user's message,
    // so the caveat has to reach that handler's transaction and not the run
    // that sets the dialog up. A context entry is where the two part company:
    // the run materializes it as a cell reference without reading its fields,
    // and the handler reads a field to build the request the turn would send.
    // So the caveat goes on the field.

    const { pattern, llmDialog, Cell: BuilderCell } = commonfabric;
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
        const messages = BuilderCell.of<BuiltInLLMMessage[]>([]);
        const briefing = BuilderCell.of({ note: "a hostile briefing" }, {
          type: "object",
          properties: {
            note: {
              type: "string",
              ifc: { confidentiality: [PROMPT_INFLUENCE] },
            },
          },
        });
        const dialog = llmDialog({ messages, context: { briefing } });
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
      "llmDialog-abandoned",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    // The run that sets the dialog up has to land: a refusal here would be the
    // caveat reaching the wrong transaction, and the wait below would then be
    // waiting on a handler that was never registered.
    const setUp = await tx.commit();
    expect(setUp.error).toBeUndefined();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "what does the briefing say?" });

    // `pending` is unwritten until the ending writes it, so the wait is for
    // the ending itself rather than for a value it changed.
    const settled = await waitForCellValue<{ pending?: boolean }>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.pending).toBe(false);
    // The turn is not in the conversation: the message the handler appended
    // rode the abandoned transaction, so the ending has no turn to answer and
    // writes no assistant message.
    expect(result.withTx().key("messages").get()).toEqual([]);
  });
  describe("and the same builtins when the transaction commits", () => {
    // An unlabelled input leaves the result store's ceiling nothing to
    // refuse, so the staging transaction commits and the work starts. The
    // mock client answers in place of a model.

    beforeEach(() => {
      enableMockMode();
      clearMockResponses();
    });

    afterEach(() => {
      resetMockMode();
    });

    it("sends llm's request and lands its result", async () => {
      const { pattern, llm, Cell: BuilderCell } = commonfabric;
      addMockResponse(() => true, {
        role: "assistant",
        content: "an answer",
        id: "abandoned-control-llm",
      });
      const testPattern = pattern<Record<string, never>>(() => {
        const messages = BuilderCell.of([{
          role: "user",
          content: "a briefing nothing labels",
        }], {
          type: "array",
          items: { type: "object", additionalProperties: true },
        });
        // deno-lint-ignore no-explicit-any
        return llm({ messages } as any);
      });
      const resultCell = runtime.getCell(
        space,
        "llm-sent",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const settled = await waitForCellValue<{ pending?: boolean }>(
        runtime,
        result,
        (value) => value?.pending === false,
      );
      await runtime.settled();

      expect(settled.pending).toBe(false);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });

    it("sends generateObject's request and lands its result", async () => {
      const { pattern, generateObject, Cell: BuilderCell } = commonfabric;
      addMockObjectResponse(() => true, {
        object: { ok: true },
        id: "abandoned-control-generate-object",
      });
      const testPattern = pattern<Record<string, never>>(() => {
        const messages = BuilderCell.of([{
          role: "user",
          content: "a briefing nothing labels",
        }], {
          type: "array",
          items: { type: "object", additionalProperties: true },
        });
        return generateObject({
          messages,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          // deno-lint-ignore no-explicit-any
        } as any);
      });
      const resultCell = runtime.getCell(
        space,
        "generateObject-sent",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const settled = await waitForCellValue<{ pending?: boolean }>(
        runtime,
        result,
        (value) => value?.pending === false,
      );
      await runtime.settled();

      expect(settled.pending).toBe(false);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });

    it("sends generateText's request and lands its result", async () => {
      const { pattern, generateText } = commonfabric;
      addMockResponse(() => true, {
        role: "assistant",
        content: "an answer",
        id: "abandoned-control-generate-text",
      });
      const testPattern = pattern<Record<string, never>>(() =>
        // deno-lint-ignore no-explicit-any
        generateText({ prompt: "a briefing nothing labels" } as any)
      );
      const resultCell = runtime.getCell(
        space,
        "generateText-sent",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const settled = await waitForCellValue<{ pending?: boolean }>(
        runtime,
        result,
        (value) => value?.pending === false,
      );
      await runtime.settled();

      expect(settled.pending).toBe(false);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });
  });
});
