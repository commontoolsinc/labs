import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { ContextualFlowControl } from "../src/cfc.ts";
import { listElementLink } from "../src/builtins/list-element-link.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";

const cfc = new ContextualFlowControl();

const base = (schema?: NormalizedFullLink["schema"]): NormalizedFullLink => ({
  id: "of:list",
  space: "did:key:list",
  scope: "space",
  path: ["items"],
  schema,
});

const linkSlot = (schema?: NormalizedFullLink["schema"]) => ({
  "/": {
    "link@1": {
      id: "of:target",
      path: ["value"],
      space: "did:key:list",
      scope: "space" as const,
      ...(schema !== undefined && { schema }),
    },
  },
});

describe("listElementLink", () => {
  const elementSchema = {
    type: "object",
    title: "parent element",
    properties: {
      parentOnly: { type: "string" },
    },
    required: ["parentOnly"],
  } as const;
  const listSchema = {
    type: "array",
    title: "list container",
    items: elementSchema,
  } as const;

  it("narrows the list schema to an inline element", () => {
    expect(listElementLink(cfc, base(listSchema), { parentOnly: "x" }, 3))
      .toEqual({
        id: "of:list",
        space: "did:key:list",
        scope: "space",
        path: ["items", "3"],
        schema: elementSchema,
      });
  });

  it("keeps an explicit link schema when the list has no schema", () => {
    const schema = { type: "string", title: "link element" } as const;
    expect(listElementLink(cfc, base(), linkSlot(schema), 0)).toEqual({
      id: "of:target",
      space: "did:key:list",
      scope: "space",
      path: ["value"],
      schema,
    });
  });

  it("does not attach the list element schema to a linked slot", () => {
    expect(listElementLink(cfc, base(listSchema), linkSlot(), 1)).toEqual({
      id: "of:target",
      space: "did:key:list",
      scope: "space",
      path: ["value"],
    });
  });

  it("keeps the link schema without narrowing the list schema", () => {
    const localCfc = new ContextualFlowControl();
    const schemaAtPath = spy(localCfc, "schemaAtPath");
    const schema = {
      type: "object",
      title: "link element",
      properties: {
        linkOnly: { type: "number" },
      },
      required: ["linkOnly"],
    } as const;

    try {
      expect(listElementLink(localCfc, base(listSchema), linkSlot(schema), 2))
        .toEqual({
          id: "of:target",
          space: "did:key:list",
          scope: "space",
          path: ["value"],
          schema,
        });
      expect(schemaAtPath.calls).toHaveLength(0);
    } finally {
      schemaAtPath.restore();
    }
  });
});
