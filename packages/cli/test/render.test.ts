import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { sanitizeForJson } from "../lib/render.ts";

describe("sanitizeForJson", () => {
  it("replaces nested cells with llm-friendly links", () => {
    const linkedCell = {
      kind: "cell",
      link: "/of:bafytest123/value",
    };

    const result = sanitizeForJson<{ kind: "cell"; link: string }>(
      {
        value: linkedCell,
        list: [linkedCell],
      },
      8,
      {
        isCellValue: isMockCell,
        serializeCell: (value) => ({ "@link": value.link }),
      },
    );

    expect(result).toEqual({
      value: { "@link": "/of:bafytest123/value" },
      list: [{ "@link": "/of:bafytest123/value" }],
    });
  });

  it("preserves circular markers for ordinary objects", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(sanitizeForJson(value)).toEqual({
      self: "<circular reference>",
    });
  });

  it("respects the max depth limit", () => {
    const value = {
      nested: {
        nested: {
          nested: "too deep",
        },
      },
    };

    expect(sanitizeForJson(value, 1)).toEqual({
      nested: {
        nested: "<max depth reached>",
      },
    });
  });
});

function isMockCell(
  value: unknown,
): value is { kind: "cell"; link: string } {
  return typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "cell" &&
    "link" in value &&
    typeof value.link === "string";
}
