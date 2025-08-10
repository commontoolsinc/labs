import { assert, assertEquals } from "@std/assert";
import { InMemoryStorage } from "../../src/query/storage.ts";
import { IRPool, compileSchema } from "../../src/query/ir.ts";
import { Provenance, Evaluator } from "../../src/query/eval.ts";
import { SubscriptionIndex } from "../../src/query/subs.ts";
import { ChangeProcessor } from "../../src/query/change_processor.ts";

Deno.test("path-walking: links inside path are followed mid-chain", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);

  storage.setDoc("doc1", {
    foo: { "/": { "link@1": { id: "doc2", path: "/inner/path" } } },
  }, { seq: 1 });

  storage.setDoc("doc2", {
    inner: { path: { bar: { "/": { "link@1": { id: "doc3", path: "" } } } } },
  }, { seq: 1 });

  storage.setDoc("doc3", { baz: 7 }, { seq: 1 });

  const ir = compileSchema(pool, { const: 7 });
  proc.registerQuery({ id: "q", doc: "doc1", path: ["foo", "bar", "baz"], ir, budget: 10 });

  const root = subs.queryRoot.get("q")!;
  const r = evalr.evaluate(root, undefined, evalr.newContext());
  assertEquals(r.verdict, "Yes");
});

Deno.test("path-walking: middle doc is touched, so its change invalidates", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);

  storage.setDoc("doc1", {
    foo: { "/": { "link@1": { id: "doc2", path: "/inner/path" } } },
  }, { seq: 1 });

  storage.setDoc("doc2", {
    inner: { path: { bar: { "/": { "link@1": { id: "doc3", path: "" } } } } },
  }, { seq: 1 });

  storage.setDoc("doc3", { baz: 7 }, { seq: 1 });

  const ir = compileSchema(pool, { const: 7 });
  proc.registerQuery({ id: "q", doc: "doc1", path: ["foo", "bar", "baz"], ir, budget: 10 });

  const d2 = storage.setDoc("doc2", {
    inner: { path: { bar: { "/": { "link@1": { id: "doc3", path: "" } } }, extra: 1 } }
  }, { seq: 2 });

  const ev = proc.onDelta(d2);
  assert(ev.some((e: any) => e.queryId === "q"));
});

Deno.test("path-walking: budget counts link hops during normalization", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);

  storage.setDoc("doc1", { foo: { "/": { "link@1": { id: "doc2", path: "/x" } } } }, { seq: 1 });
  storage.setDoc("doc2", { x: { "/": { "link@1": { id: "doc3", path: "/y" } } } }, { seq: 1 });
  storage.setDoc("doc3", { y: { "/": { "link@1": { id: "doc4", path: "" } } } }, { seq: 1 });
  storage.setDoc("doc4", { v: 1 }, { seq: 1 });

  const ir = compileSchema(pool, { type: "object", properties: { v: { const: 1 } } });
  proc.registerQuery({ id: "q1", doc: "doc1", path: ["foo", "v"], ir, budget: 3 });
  const r1 = evalr.evaluate(subs.queryRoot.get("q1")!, undefined, evalr.newContext());
  assertEquals(r1.verdict, "Yes");

  proc.registerQuery({ id: "q2", doc: "doc1", path: ["foo", "v"], ir, budget: 2 });
  const r2 = evalr.evaluate(subs.queryRoot.get("q2")!, undefined, evalr.newContext());
  assertEquals(r2.verdict, "MaybeExceededDepth");
});

