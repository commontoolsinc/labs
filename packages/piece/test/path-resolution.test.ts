import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { resolveCellPath } from "../src/ops/utils.ts";

interface FakeCell {
  get(): unknown;
  key(segment: string | number): FakeCell;
}

function makeCell(
  value: unknown,
  children: Record<string, FakeCell> = {},
): FakeCell {
  return {
    get() {
      return value;
    },
    key(segment: string | number) {
      return children[String(segment)] ?? makeCell(undefined);
    },
  };
}

describe("resolveCellPath", () => {
  it("resolves schema-backed child cells when the parent object is sparse", () => {
    const cell = makeCell(undefined, {
      messageCount: makeCell(1),
    });

    assertEquals(resolveCellPath(cell as never, ["messageCount"]), 1);
  });

  it("throws when the requested path is missing", () => {
    const cell = makeCell(undefined);

    assertThrows(
      () => resolveCellPath(cell as never, ["missing"]),
      Error,
      'property "missing" not found',
    );
  });

  it("throws when traversing through a non-object value", () => {
    const cell = makeCell({
      settings: "plain-text",
    }, {
      settings: makeCell("plain-text"),
    });

    assertThrows(
      () => resolveCellPath(cell as never, ["settings", "theme"]),
      Error,
      'encountered non-object at "theme"',
    );
  });
});
