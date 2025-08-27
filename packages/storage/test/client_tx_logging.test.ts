import { assertEquals } from "@std/assert";
import { ClientTransaction } from "../src/client/tx.ts";

Deno.test({ name: "client tx: read/write log entries" }, async () => {
  const tx = new ClientTransaction();
  // Default read uses nolog=true; read with logging enabled
  tx.read("did:key:space", "doc:log", ["a", "b"], false);
  // Write logs a write entry (root path always exists)
  tx.write("did:key:space", "doc:log", [], (sub: any) => {
    if (!sub || typeof sub !== "object") return;
    (sub as any).a = { b: 1 };
  });
  const entries = tx.log;
  assertEquals(entries.length, 2);
  assertEquals(entries[0], {
    space: "did:key:space",
    docId: "doc:log",
    path: ["a", "b"],
    op: "read",
  });
  assertEquals(entries[1], {
    space: "did:key:space",
    docId: "doc:log",
    path: [],
    op: "write",
  });
});
