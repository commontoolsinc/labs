import { assertEquals } from "@std/assert";
import { ClientStore } from "../src/client/store.ts";

Deno.test(
  { name: "client store: composed view prefers pending over server" },
  () => {
    const store = new ClientStore();
    const space = "did:key:unit";
    const doc = "doc:s";

    // Seed server state
    store.applyServerDoc({
      space,
      docId: doc,
      epoch: 1,
      heads: [],
      json: { v: 1 },
    });
    let v = store.readView(space, doc).json as any;
    assertEquals(v?.v, 1);

    // Apply pending overlay and expect composed to reflect it
    store.applyPending({ space, docId: doc, id: "t1", json: { v: 2 } });
    v = store.readView(space, doc).json as any;
    assertEquals(v?.v, 2);

    // Promote overlay to server; composed remains 2
    store.promotePendingToServer({
      space,
      docId: doc,
      id: "t1",
      epoch: 2,
      heads: [],
    });
    v = store.readView(space, doc).json as any;
    assertEquals(v?.v, 2);

    // Add another pending then clear it; composed returns server
    store.applyPending({ space, docId: doc, id: "t2", json: { v: 3 } });
    v = store.readView(space, doc).json as any;
    assertEquals(v?.v, 3);
    store.clearPending({ space, docId: doc, id: "t2" });
    v = store.readView(space, doc).json as any;
    assertEquals(v?.v, 2);
  },
);
