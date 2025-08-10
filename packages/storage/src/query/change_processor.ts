import { Delta, EngineEvent, Link, Verdict } from "./types.ts";
import { DEFAULT_LINK_BUDGET, EvalKey, Evaluator, Provenance } from "./eval.ts";
import { SubscriptionIndex } from "./subs.ts";

export class ChangeProcessor {
  constructor(
    private evaluator: Evaluator,
    private prov: Provenance,
    private subs: SubscriptionIndex,
  ) {}
  private queryVerdict = new Map<string, Verdict>();
  private queryTouches = new Map<string, Set<Link>>();

  private collectTouches(root: EvalKey): Set<Link> {
    const out = new Set<Link>();
    const seen = new Set<string>();
    const dfs = (k: EvalKey) => {
      const ks = SubscriptionIndex.keyEval(k);
      if (seen.has(ks)) return;
      seen.add(ks);
      const r = this.evaluator.memo.get(ks);
      if (!r) return;
      r.touches.forEach((c) => out.add(c));
      r.deps.forEach((child) => dfs(child));
    };
    dfs(root);
    return out;
  }

  registerQuery(
    q: { id: string; doc: string; path: string[]; ir: string; budget?: number },
  ) {
    const root: EvalKey = {
      ir: q.ir,
      doc: q.doc,
      path: q.path,
      budget: q.budget ?? DEFAULT_LINK_BUDGET,
    };
    const res = this.evaluator.evaluate(
      root,
      undefined,
      this.evaluator.newContext(),
    );
    const touches = this.collectTouches(root);
    this.subs.registerQuery(q, root, touches);
    this.queryVerdict.set(q.id, res.verdict);
    this.queryTouches.set(q.id, touches);
  }

  onDelta(delta: Delta): EngineEvent[] {
    const affected = new Set<string>(); // eval keys
    const mark = (pathKey: string) => {
      const lk = `${delta.doc}\u0001${pathKey}`;
      const es = this.prov.linkToEval.get(lk);
      if (es) es.forEach((e) => affected.add(e));
    };
    delta.changed.forEach(mark);
    delta.removed.forEach(mark);

    // Expand to parents
    const dirty = new Set<string>(affected);
    const q: string[] = [...affected];
    while (q.length) {
      const e = q.pop()!;
      const ps = this.prov.evalParents.get(e);
      if (ps) {
        for (const p of ps) {
          if (!dirty.has(p)) {
            dirty.add(p);
            q.push(p);
          }
        }
      }
    }

    // TOPO sort children→parents within the dirty induced subgraph (Kahn)
    const indeg = new Map<string, number>();
    for (const e of dirty) indeg.set(e, 0);
    for (const p of dirty) {
      const ch = this.prov.evalChildren.get(p);
      if (!ch) continue;
      for (const c of ch) {
        if (dirty.has(c)) indeg.set(c, (indeg.get(c) || 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [n, d] of indeg) if (d === 0) queue.push(n);
    const order: string[] = [];
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      const ch = this.prov.evalChildren.get(n);
      if (!ch) continue;
      for (const c of ch) {
        if (dirty.has(c)) {
          indeg.set(c, indeg.get(c)! - 1);
          if (indeg.get(c) === 0) queue.push(c);
        }
      }
    }
    for (const e of dirty) if (!order.includes(e)) order.push(e);

    // Re-evaluate in order
    for (const ek of order) {
      const [ir, doc, pathKey, budgetStr] = ek.split("\u0001");
      this.evaluator.memo.delete(ek);
      this.evaluator.evaluate(
        {
          ir,
          doc,
          path: JSON.parse(pathKey),
          budget: Number(budgetStr),
        },
        undefined,
        this.evaluator.newContext(),
      );
    }

    // Affected queries
    const events: EngineEvent[] = [];
    for (const [qid, root] of this.subs.queryRoot.entries()) {
      const rootKey = SubscriptionIndex.keyEval(root);
      let intersects = dirty.has(rootKey);
      if (!intersects) {
        const old = this.queryTouches.get(qid) || new Set<Link>();
        for (const l of old) {
          if (
            l.doc === delta.doc &&
            (delta.changed.has(JSON.stringify(l.path)) ||
              delta.removed.has(JSON.stringify(l.path)))
          ) {
            intersects = true;
            break;
          }
        }
        if (!intersects) continue;
      }
      const res = this.evaluator.evaluate(
        root,
        undefined,
        this.evaluator.newContext(),
      );
      const newTouches = this.collectTouches(root);
      const oldTouches = this.queryTouches.get(qid) || new Set<Link>();

      const add: Link[] = [];
      const rem: Link[] = [];
      const exists = (set: Set<Link>, l: Link) =>
        [...set].some(
          (x) =>
            x.doc === l.doc &&
            JSON.stringify(x.path) === JSON.stringify(l.path),
        );
      for (const l of newTouches) if (!exists(oldTouches, l)) add.push(l);
      for (const l of oldTouches) if (!exists(newTouches, l)) rem.push(l);

      const verdictChanged = this.queryVerdict.get(qid) !== res.verdict;
      const changedDocs = new Set<string>([
        ...new Set([...add, ...rem].map((c) => c.doc)),
      ]);
      // If the delta intersects this query (directly or via dependency graph),
      // include the delta doc in changedDocs to guarantee a notification.
      changedDocs.add(delta.doc);

      if (
        verdictChanged || add.length || rem.length || changedDocs.has(delta.doc)
      ) {
        events.push({
          queryId: qid,
          verdictChanged,
          touchAdded: add,
          touchRemoved: rem,
          changedDocs,
          atVersion: delta.atVersion,
        });
        this.queryVerdict.set(qid, res.verdict);
        this.queryTouches.set(qid, newTouches);
      }
    }

    return events;
  }
}
