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
 */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { Cell } from "../src/builder/types.ts";
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
});
