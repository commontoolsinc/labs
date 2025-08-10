import { InMemoryStorage } from "./storage.ts";
import { compileSchema, IRPool } from "./ir.ts";
import { Evaluator, Provenance } from "./eval.ts";
import { Query, SubscriptionIndex } from "./subs.ts";
import { ChangeProcessor } from "./change_processor.ts";
import { DeliveryManager, InMemoryOutbox } from "./delivery.ts";

export function demo() {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evaluator = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const processor = new ChangeProcessor(evaluator, prov, subs);
  const outbox = new InMemoryOutbox();
  const delivery = new DeliveryManager(storage, outbox);

  storage.setDoc("A", {
    foo: { bar: 1 },
    link: { "/": { "link@1": { id: "B", path: [] } } },
  }, { seq: 1 });
  storage.setDoc("B", { name: "docB" }, { seq: 1 });

  const schema = {
    type: "object",
    required: ["foo"],
    properties: {
      foo: { type: "object", properties: { bar: { type: "number" } } },
    },
  }; // AP omitted
  const ir = compileSchema(pool, schema);
  const q: Query = { id: "q1", doc: "A", path: [], ir, budget: 2 };
  processor.registerQuery(q);

  const touches = new Set<string>(["A"]); // simplified doc set for backfill
  delivery.startSubscription("client1", q.id, new Set(touches), { seq: 1 });

  console.log("-- Initial backfill --");
  outbox.drain("client1", (m) => {
    console.log("SEND", m);
    if (m.type === "DOC_UPDATE") {
      delivery.onAckDoc("client1", m.docId, m.version);
    }
  });

  const dA = storage.setDoc("A", {
    foo: { bar: 2 },
    link: { "/": { "link@1": { id: "B", path: [] } } },
  }, { seq: 2 });
  const evA = processor.onDelta(dA);
  delivery.handleEngineEvents("client1", evA);
  outbox.drain("client1", (m) => {
    console.log("SEND", m);
    if (m.type === "DOC_UPDATE") {
      delivery.onAckDoc("client1", m.docId, m.version);
    }
  });
}
