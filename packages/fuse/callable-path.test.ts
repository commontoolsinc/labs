import { assertEquals } from "@std/assert";
import { parseMountedCallablePath } from "./callable-path.ts";

Deno.test("parseMountedCallablePath accepts piece handler paths", () => {
  assertEquals(
    parseMountedCallablePath("home/pieces/notes/input/addItem.handler"),
    {
      spaceName: "home",
      rootKind: "pieces",
      rootName: "notes",
      cellProp: "input",
      cellKey: "addItem",
      callableKind: "handler",
    },
  );
});

Deno.test("parseMountedCallablePath accepts piece tool paths", () => {
  assertEquals(
    parseMountedCallablePath("home/pieces/notes/result/search.tool"),
    {
      spaceName: "home",
      rootKind: "pieces",
      rootName: "notes",
      cellProp: "result",
      cellKey: "search",
      callableKind: "tool",
    },
  );
});

Deno.test("parseMountedCallablePath accepts entity handler paths", () => {
  assertEquals(
    parseMountedCallablePath("home/entities/of:abc123/result/addItem.handler"),
    {
      spaceName: "home",
      rootKind: "entities",
      rootName: "of:abc123",
      cellProp: "result",
      cellKey: "addItem",
      callableKind: "handler",
    },
  );
});

Deno.test("parseMountedCallablePath accepts entity tool paths", () => {
  assertEquals(
    parseMountedCallablePath("home/entities/abc123/input/search.tool"),
    {
      spaceName: "home",
      rootKind: "entities",
      rootName: "abc123",
      cellProp: "input",
      cellKey: "search",
      callableKind: "tool",
    },
  );
});

Deno.test("parseMountedCallablePath rejects unsupported and nested paths", () => {
  assertEquals(
    parseMountedCallablePath("home/pieces/notes/result.json"),
    null,
  );
  assertEquals(
    parseMountedCallablePath(
      "home/pieces/notes/result/search.tool/pattern/argumentSchema",
    ),
    null,
  );
  assertEquals(
    parseMountedCallablePath(
      "home/pieces/notes/result/search/extraParams/query",
    ),
    null,
  );
  assertEquals(
    parseMountedCallablePath("home/pieces/notes/result/search"),
    null,
  );
});
