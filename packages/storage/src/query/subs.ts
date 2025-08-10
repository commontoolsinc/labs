import { Link, Path } from "./types.ts";
import { EvalKey } from "./eval.ts";
import { keyPath } from "./path.ts";

export type Query = {
  id: string;
  doc: string;
  path: Path;
  ir: string;
  budget?: number;
};

export class SubscriptionIndex {
  evalToQueries = new Map<string, Set<string>>();
  linkToQueries = new Map<string, Set<string>>();
  queryRoot = new Map<string, EvalKey>();

  static keyLink(l: Link) {
    return `${l.doc}\u0001${keyPath(l.path)}`;
  }
  static keyEval(k: EvalKey) {
    return `${k.ir}\u0001${k.doc}\u0001${keyPath(k.path)}\u0001${k.budget}`;
  }

  registerQuery(q: Query, root: EvalKey, initialTouches: Set<Link>) {
    this.queryRoot.set(q.id, root);
    const rootKeyStr = SubscriptionIndex.keyEval(root);
    if (!this.evalToQueries.has(rootKeyStr)) {
      this.evalToQueries.set(rootKeyStr, new Set());
    }
    this.evalToQueries.get(rootKeyStr)!.add(q.id);
    for (const l of initialTouches) {
      const lk = SubscriptionIndex.keyLink(l);
      if (!this.linkToQueries.has(lk)) this.linkToQueries.set(lk, new Set());
      this.linkToQueries.get(lk)!.add(q.id);
    }
  }
}
