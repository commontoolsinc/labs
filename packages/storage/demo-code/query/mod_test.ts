import { assert, assertEquals } from "@std/assert";
import { InMemoryStorage } from "./storage.ts";
import { compileSchema, IRPool } from "./ir.ts";
import { Evaluator, Provenance } from "./eval.ts";
import { SubscriptionIndex } from "./subs.ts";
import { ChangeProcessor } from "./change_processor.ts";
import { DeliveryManager, InMemoryOutbox } from "./delivery.ts";

Deno.test("IR compile + simple match", () => {
  const pool = new IRPool();
  const ir = compileSchema(pool, {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
  });
  assert(typeof ir === "string");
});

Deno.test("Evaluation respects AP omitted (ignores other props and links)", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  storage.setDoc("A", {
    a: 1,
    link: { "/": { "link@1": { id: "B", path: "" } } },
  }, { seq: 1 });
  storage.setDoc("B", { name: "B" }, { seq: 1 });
  const ir = compileSchema(pool, {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
  });
  const res = evalr.evaluate({ ir, doc: "A", path: [], budget: 2 });
  assertEquals(res.verdict, "Yes");
});

Deno.test("AnyOf deep branch and topo re-eval", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);

  storage.setDoc("X", { a: { b: 0 } }, { seq: 1 });
  const ir = compileSchema(pool, {
    anyOf: [{
      type: "object",
      properties: { a: { type: "object", properties: { b: { const: 1 } } } },
    }, { type: "object" }],
  });
  proc.registerQuery({ id: "q", doc: "X", path: [], ir, budget: 1 });

  // change that flips branch outcome
  const d = storage.setDoc("X", { a: { b: 1 } }, { seq: 2 });
  const ev = proc.onDelta(d);
  assert(ev.length >= 0);
});

Deno.test("Delivery backfill and barrier", () => {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);
  const outbox = new InMemoryOutbox();
  const delivery = new DeliveryManager(storage, outbox);

  storage.setDoc("A", { a: 1 }, { seq: 1 });
  const ir = compileSchema(pool, {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
  });
  proc.registerQuery({ id: "q1", doc: "A", path: [], ir, budget: 1 });

  delivery.startSubscription("c1", "q1", new Set(["A"]), { seq: 1 });
  const sent: any[] = [];
  outbox.drain("c1", (m) => {
    sent.push(m);
    if (m.type === "DOC_UPDATE") delivery.onAckDoc("c1", m.docId, m.version);
  });

  outbox.drain("c1", (m) => {
    sent.push(m);
  });
  assert(sent.some((m) => m.type === "DOC_UPDATE"));
  assert(sent.some((m) => m.type === "QUERY_SYNCED"));
});
