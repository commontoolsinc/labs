import { assertEquals } from "@std/assert";
import * as Selection from "../selection.ts";

Deno.test("iterate returns correct entries for multi-level selection", () => {
  const selection = {
    "of:entity1": {
      "application/json": {
        "cause1": { is: "value1", since: 0 },
        "cause2": { is: "value2", since: 1 },
      },
      "text/plain": {
        "cause3": { is: "value3", since: 2 },
      },
    },
    "of:entity2": {
      "application/json": {
        "cause4": { is: "value4", since: 3 },
      },
    },
  };

  const results = Array.from(Selection.iterate(selection));

  // Should return 4 entries (flattened from nested structure)
  assertEquals(results.length, 4);

  // Verify structure of entries
  const sorted = results.sort((a, b) =>
    `${a.of}|${a.the}|${a.cause}`.localeCompare(`${b.of}|${b.the}|${b.cause}`)
  );

  assertEquals(sorted[0].of, "of:entity1");
  assertEquals(sorted[0].the, "application/json");
  assertEquals(sorted[0].cause, "cause1");
  assertEquals(sorted[0].value, { is: "value1", since: 0 });

  assertEquals(sorted[3].of, "of:entity2");
  assertEquals(sorted[3].the, "application/json");
  assertEquals(sorted[3].cause, "cause4");
  assertEquals(sorted[3].value, { is: "value4", since: 3 });
});

Deno.test("iterate handles empty selection", () => {
  const selection = {};
  const results = Array.from(Selection.iterate(selection));
  assertEquals(results.length, 0);
});

Deno.test("iterate handles single entry", () => {
  const selection = {
    "of:single": {
      "application/json": {
        "cause1": { value: "test" },
      },
    },
  };

  const results = Array.from(Selection.iterate(selection));
  assertEquals(results.length, 1);
  assertEquals(results[0].of, "of:single");
  assertEquals(results[0].the, "application/json");
  assertEquals(results[0].cause, "cause1");
  assertEquals(results[0].value, { value: "test" });
});
