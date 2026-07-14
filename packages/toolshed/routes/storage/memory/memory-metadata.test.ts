import { assertEquals } from "@std/assert";
import { memoryWireConnectionMetadataFromHeaders } from "./memory-metadata.ts";

Deno.test("memoryWireConnectionMetadataFromHeaders classifies Mozilla user agents as browser", () => {
  const headers = new Headers({
    "user-agent": "Mozilla/5.0 diagnostic browser",
    origin: "http://localhost:5173",
  });

  assertEquals(memoryWireConnectionMetadataFromHeaders(headers), {
    kind: "browser",
    userAgent: "Mozilla/5.0 diagnostic browser",
    origin: "http://localhost:5173",
  });
});

Deno.test("memoryWireConnectionMetadataFromHeaders classifies non-browser clients as runtime", () => {
  const headers = new Headers({
    "user-agent": "Deno/2.0 cf-runtime",
  });

  assertEquals(memoryWireConnectionMetadataFromHeaders(headers), {
    kind: "runtime",
    userAgent: "Deno/2.0 cf-runtime",
  });
});

Deno.test("memoryWireConnectionMetadataFromHeaders emits only non-secret diagnostic strings", () => {
  const headers = new Headers({
    authorization: "Bearer do-not-copy",
    cookie: "session=do-not-copy",
  });

  assertEquals(memoryWireConnectionMetadataFromHeaders(headers), {
    kind: "runtime",
  });
});
