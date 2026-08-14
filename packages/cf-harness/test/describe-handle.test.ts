/**
 * `describe_handle` is the shape-inspection seam: it answers what a handle
 * token refers to — schema and path — and never what the referent holds. It
 * has no fabric session and never dereferences a cell, so an answer is
 * assembled entirely from the run's own handle table.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { describeHandleTool } from "../src/tools/describe-handle.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

const HASH_A = "A".repeat(43);
const REF_A = `/of:fid1:${HASH_A}/summary`;

const DOUBLED_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

/**
 * The two context members `describe_handle` reads. Everything else on a tool
 * context — sandbox, host runner, fabric session — is deliberately unused by
 * this tool, so a stub that supplies more would misstate what it can reach.
 */
const contextWith = (table?: HarnessHandleTable): HarnessToolContext =>
  ({
    ...(table !== undefined ? { handleTable: table } : {}),
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-describe", toolId, 1),
  }) as unknown as HarnessToolContext;

describe("describe_handle", () => {
  it("returns the recorded schema for a known token and nothing but shape", async () => {
    const minted = await mintAddressHandle(
      createHarnessHandleTable("run-describe"),
      REF_A,
      { schema: DOUBLED_SCHEMA },
    );

    const output = await describeHandleTool.invoke(
      contextWith(minted.table),
      { token: minted.token },
    );

    expect(output.known).toBe(true);
    expect(output.hasSchema).toBe(true);
    expect(output.schema).toEqual(DOUBLED_SCHEMA);
    expect(output.token).toBe(minted.token);
    // Shape only: the reply's fields are the documented ones, so no value,
    // reference, or address can ride out on an undeclared field.
    expect(Object.keys(output).sort()).toEqual(
      ["hasSchema", "known", "outputId", "path", "schema", "token"],
    );
  });

  it("reports the path of a known token that carries no schema", async () => {
    const minted = await mintAddressHandle(
      createHarnessHandleTable("run-describe"),
      REF_A,
    );

    const output = await describeHandleTool.invoke(
      contextWith(minted.table),
      { token: minted.token },
    );

    expect(output.known).toBe(true);
    expect(output.hasSchema).toBe(false);
    expect(output.schema).toBeUndefined();
    expect(output.path).toEqual(["summary"]);
  });

  it("reports a token it does not know without throwing", async () => {
    const output = await describeHandleTool.invoke(
      contextWith(createHarnessHandleTable("run-describe")),
      { token: "cfh:a:zzzzz" },
    );

    expect(output.known).toBe(false);
    expect(output.hasSchema).toBe(false);
    expect(output.token).toBe("cfh:a:zzzzz");
  });

  it("reports any token as unknown in a run that has minted none", async () => {
    const output = await describeHandleTool.invoke(
      contextWith(),
      { token: "cfh:a:zzzzz" },
    );

    expect(output.known).toBe(false);
  });
});
