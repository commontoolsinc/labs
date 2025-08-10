import { assertEquals } from "@std/assert";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { InMemoryStorage } from "../../src/query/storage.ts";

Deno.test("compileSchema handles self-recursive $ref", () => {
  const pool = new IRPool();
  const schema = {
    definitions: {
      VNode: {
        type: "object",
        properties: {
          tag: { enum: ["div", "span"] },
          children: { type: "array", items: { $ref: "#/definitions/VNode" } },
        },
      },
    },
    $ref: "#/definitions/VNode",
  };
  const id = compileSchema(pool, schema);
  const node = pool.get(id);
  assertEquals(typeof node, "object");

  // Evaluate over a small recursive doc graph
  const storage = new InMemoryStorage();
  storage.setDoc("root", {
    tag: "div",
    children: [{ tag: "span", children: [] }],
  }, { seq: 1 });
  const ev = new Evaluator(pool, storage, new Provenance());
  const res = ev.evaluate({ ir: id, doc: "root", path: [], budget: 3 });
  assertEquals(
    res.verdict === "Yes" || res.verdict === "MaybeExceededDepth",
    true,
  );
});

Deno.test("compileSchema handles mutual recursion via $ref", () => {
  const pool = new IRPool();
  const schema = {
    definitions: {
      A: {
        type: "object",
        properties: { b: { $ref: "#/definitions/B" } },
      },
      B: {
        type: "object",
        properties: { a: { $ref: "#/definitions/A" } },
      },
    },
    $ref: "#/definitions/A",
  };
  const id = compileSchema(pool, schema);
  const node = pool.get(id);
  assertEquals(typeof node, "object");

  // Evaluate mutual recursion with shallow budget
  const storage = new InMemoryStorage();
  storage.setDoc("docA", { b: { a: { b: {} } } }, { seq: 1 });
  const ev = new Evaluator(pool, storage, new Provenance());
  const res = ev.evaluate({ ir: id, doc: "docA", path: [], budget: 2 });
  assertEquals(
    ["Yes", "MaybeExceededDepth"].includes(res.verdict as any),
    true,
  );
});
