import { assert, assertEquals } from "@std/assert";
import { InMemoryStorage } from "../../src/query/storage.ts";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";

// Helper to create LinkValue objects
function link(doc: string, pathTokens: string[] = []): any {
  return { "/": { "link@1": { id: doc, path: pathTokens } } };
}

// Seed a tiny, acyclic VDOM graph: vdom:0..N-1 with children pointing to higher index
function seedVDOM(storage: InMemoryStorage, N: number) {
  const TAGS = ["div", "span", "ul", "li", "p", "section"] as const;
  for (let i = 0; i < N; i++) {
    const tag = TAGS[i % TAGS.length] as any;
    const kids: any[] = [];
    // simple fanout: i -> i+1 and i+2 if in bounds
    if (i + 1 < N) kids.push(link(`vdom:${i + 1}`));
    if (i % 3 === 0 && i + 2 < N) kids.push(link(`vdom:${i + 2}`));
    storage.setDoc(
      `vdom:${i}`,
      { tag, props: { id: `n-${i}`, idx: i, visible: true }, children: kids },
      { seq: 1 },
    );
  }
}

Deno.test("vdom basic: recursive VNode schema validates small graph", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evaluator = new Evaluator(pool, storage, prov, { visitLimit: 1024 });

  seedVDOM(storage, 10);

  const VNodeRecursive = {
    $defs: {
      VNode: {
        type: "object",
        properties: {
          tag: { enum: ["div", "span", "ul", "li", "p", "section"] },
          props: { type: "object", additionalProperties: true },
          children: { type: "array", items: { $ref: "#/$defs/VNode" } },
        },
      },
    },
    $ref: "#/$defs/VNode",
  } as const;
  const ir = compileSchema(pool, VNodeRecursive as any);

  // Validate a few nodes; should not time out and should not be "No"
  for (let i = 0; i < 5; i++) {
    const res = evaluator.evaluate({ ir, doc: `vdom:${i}`, path: [] });
    assert(res.verdict !== "No");
  }
});

Deno.test({
  name: "vdom filter: tag=span flips from No to Yes after edit (direct doc)",
}, () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evaluator = new Evaluator(pool, storage, prov, { visitLimit: 1024 });

  seedVDOM(storage, 10);

  const schema = { type: "object", properties: { tag: { enum: ["span"] } } };
  const ir = compileSchema(pool, schema);

  // Verify vdom:0 starts as div → No
  const before = evaluator.evaluate({ ir, doc: "vdom:0", path: [] });
  assertEquals(before.verdict, "No");
  // Edit vdom:0 to span (direct doc evaluation, no link traversal)
  storage.setDoc(
    "vdom:0",
    { tag: "span", props: { id: "n-0", idx: 0, visible: true }, children: [] },
    { seq: 2 },
  );
  (evaluator as any)["memo"].clear();
  const after = evaluator.evaluate({ ir, doc: "vdom:0", path: [] });
  assertEquals(after.verdict, "Yes");
});
