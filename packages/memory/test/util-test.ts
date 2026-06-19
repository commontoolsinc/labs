import { assert, assertEquals } from "@std/assert";
import { fromDID } from "../util.ts";

Deno.test("fromDID wraps did:key parser errors as syntax errors", async () => {
  const unsupportedDid =
    "did:key:z6DtMrg4Kv51UMAM8vJcCLcRywJfEB4dpHVxPCR6qm6hSV3N";

  const result = await fromDID(unsupportedDid);

  assert(result.error instanceof SyntaxError);
  assertEquals(
    result.error.message,
    `Invalid DID "${unsupportedDid}", RangeError: Unsupported key algorithm expected 0xed, instead of 0xe7`,
  );
});
