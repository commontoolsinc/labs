import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

import { toBytesForTest } from "./ws_v2_utils.ts";

Deno.test("ws v2: toBytes accepts base64 and numeric arrays", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const b64 = encodeBase64(bytes);
  assertEquals(toBytesForTest(bytes), bytes);
  assertEquals(toBytesForTest(b64), bytes);
  assertEquals(toBytesForTest([1, 2, 3] as any), bytes);
});
