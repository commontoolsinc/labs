import { assertEquals } from "@std/assert";
import { IRPool, compileSchema } from "../../src/query/ir.ts";

Deno.test("compileSchema supports nested $defs and deep $ref paths", () => {
  const pool = new IRPool();
  const schema = {
    $defs: {
      a: {
        $defs: {
          b: {
            type: "object",
            properties: {
              val: { type: "number", minimum: 0 },
              next: { $ref: "#/$defs/a/$defs/b" },
            },
          },
        },
      },
    },
    $ref: "#/$defs/a/$defs/b",
  };
  const id = compileSchema(pool, schema);
  const node = pool.get(id);
  assertEquals(typeof node, "object");
});

