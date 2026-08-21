import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  llmDialogTestHelpers,
  llmToolExecutionHelpers,
} from "../src/builtins/llm-dialog.ts";

const { buildToolCatalog } = llmToolExecutionHelpers;
const { toolAllowsObservedConfidentiality } = llmDialogTestHelpers;

// A pattern may supply a tool whose name is also a built-in's — `read` and
// `schema` are names an author reaches for. `resolveToolCall` consults the
// pattern's tools first, so the pattern's tool is what runs; the catalog has
// to advertise that same tool. When a built-in overwrote the entry instead,
// the model was shown the built-in's input schema while the pattern's tool
// executed, and both CFC gates read their policy off the built-in's schema,
// which declares none.
describe("llmDialog built-in tool shadowing", () => {
  const shadowingToolsCell = (inputSchema: unknown) => {
    const cells = new Map<string, unknown>();
    return {
      cells,
      toolsCell: {
        get: () => ({
          read: { description: "the pattern's own read", inputSchema },
        }),
        key(name: string) {
          const cell = { get: () => undefined };
          cells.set(name, cell);
          return cell;
        },
      },
    };
  };

  const patternSchema = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  };

  it("advertises the pattern's tool, not the built-in it shadows", () => {
    const { toolsCell } = shadowingToolsCell(patternSchema);

    const catalog = buildToolCatalog(toolsCell as any);

    expect(catalog.llmTools.read.description).toBe("the pattern's own read");
    expect((catalog.llmTools.read.inputSchema as any).properties).toEqual({
      query: { type: "string" },
    });
  });

  it("keeps the pattern's tool as the execution target", () => {
    const { toolsCell, cells } = shadowingToolsCell(patternSchema);

    const catalog = buildToolCatalog(toolsCell as any);

    expect(catalog.dynamicToolCells.get("read")).toBe(cells.get("read"));
  });

  it("still advertises the built-ins the pattern did not shadow", () => {
    const { toolsCell } = shadowingToolsCell(patternSchema);

    const catalog = buildToolCatalog(toolsCell as any);

    for (const name of ["invoke", "pin", "unpin", "updateArgument", "schema"]) {
      expect(name in catalog.llmTools).toBe(true);
    }
  });

  it("enforces the shadowing tool's confidentiality ceiling", () => {
    const { toolsCell } = shadowingToolsCell({
      ...patternSchema,
      ifc: { maxConfidentiality: [] },
    });

    const catalog = buildToolCatalog(toolsCell as any);

    // The built-in `read` schema declares no ceiling, so before the catalog
    // agreed with dispatch this read as allow-all and the tool's declared
    // "public only" ceiling was discarded.
    expect(
      toolAllowsObservedConfidentiality(catalog as any, "read", ["secret"]),
    ).toBe(false);
    expect(toolAllowsObservedConfidentiality(catalog as any, "read", [])).toBe(
      true,
    );
  });
});
