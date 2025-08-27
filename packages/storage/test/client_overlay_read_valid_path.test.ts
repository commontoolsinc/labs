import { assert, assertEquals } from "@std/assert";
import { ClientTransaction } from "../src/client/tx.ts";

Deno.test({
  name: "client tx: read() reflects staged write and validPathOut",
}, async () => {
  const tx = new ClientTransaction();
  // No staged writes yet: read returns undefined, validPathOut empty
  {
    const out: string[] = [];
    const v = tx.read("did:key:unit", "doc:u", [], false, out);
    assertEquals(v, undefined);
    assertEquals(out, []);
  }

  // Stage a write at root path
  const ok = tx.write("did:key:unit", "doc:u", [], (root: any) => {
    root.kind = "unit";
    root.count = 1;
    root.items = ["a", "b"];
  });
  assert(ok);

  // Read back at root
  {
    const out: string[] = [];
    const v = tx.read("did:key:unit", "doc:u", [], false, out) as any;
    assertEquals(out, []);
    assertEquals(v?.kind, "unit");
    assertEquals(v?.count, 1);
  }

  // Read an existing nested path -> validPathOut matches full path
  {
    const out: string[] = [];
    const v = tx.read("did:key:unit", "doc:u", ["items"], false, out) as any[];
    assertEquals(out, ["items"]);
    assert(Array.isArray(v));
  }

  // Read a missing nested path -> validPathOut should stop at existing prefix
  {
    const out: string[] = [];
    const v = tx.read(
      "did:key:unit",
      "doc:u",
      ["items", "9"],
      false,
      out,
    );
    assertEquals(v, undefined);
    assertEquals(out, ["items"]);
  }
});
