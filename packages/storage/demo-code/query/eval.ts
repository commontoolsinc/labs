import { DocId, Link, Path, PathKey, Verdict, Version } from "./types.ts";
import { IRId, IRPool } from "./ir.ts";
import { Storage } from "./storage.ts";
import { child, keyPath, toTokens } from "./path.ts";

export type EvalKey = { ir: IRId; doc: DocId; path: Path; budget: number };
export type EvalResult = {
  verdict: Verdict;
  touches: Set<Link>;
  linkEdges: Set<{ from: Link; to: Link }>;
  deps: Set<EvalKey>;
};

function isObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

export type LinkValue = { "/": { "link@1": { id: DocId; path: string } } }; // note: link path stays JSON Pointer at the boundary

export function isLinkValue(v: any): v is LinkValue {
  return isObject(v) && isObject(v["/"]) && isObject(v["/"]["link@1"]) &&
    typeof v["/"]["link@1"].id === "string" &&
    typeof v["/"]["link@1"].path === "string";
}

export class Provenance {
  // Reverse indexes
  linkToEval = new Map<string, Set<string>>(); // key(doc +  + keyPath(path)) -> evalKey
  evalParents = new Map<string, Set<string>>();
  evalChildren = new Map<string, Set<string>>();
  linkEdges = new Map<string, Set<string>>(); // evalKeyStr -> Set<linkKey target>

  static keyLink(c: Link): string {
    return `${c.doc}${keyPath(c.path)}`;
  }
  static keyEval(k: EvalKey): string {
    return `${k.ir}${k.doc}${keyPath(k.path)}${k.budget}`;
  }
}

export class Evaluator {
  constructor(
    private pool: IRPool,
    private storage: Storage,
    private prov: Provenance,
  ) {}
  memo = new Map<string, EvalResult>();

  evaluate(key: EvalKey, at?: Version): EvalResult {
    const ek = Provenance.keyEval(key);
    const cached = this.memo.get(ek);
    if (cached) return cached;

    const touches = new Set<Link>();
    const linkEdges = new Set<{ from: Link; to: Link }>();
    const deps = new Set<EvalKey>();

    const node = this.pool.get(key.ir);

    const readLink = (doc: DocId, path: Path) => {
      const l = { doc, path } as Link;
      touches.add(l);
      const lk = Provenance.keyLink(l);
      if (!this.prov.linkToEval.has(lk)) {
        this.prov.linkToEval.set(lk, new Set());
      }
      this.prov.linkToEval.get(lk)!.add(ek);
    };

    const v = this.storage.read(key.doc, key.path, at);
    readLink(key.doc, key.path);

    const descend = (irId: IRId, val: any): Verdict => {
      const ir = this.pool.get(irId);
      switch (ir.kind) {
        case "True":
          return "Yes";
        case "False":
          return "No";
        case "TypeCheck": {
          const t = ir.t;
          const ok = (t === "object" && isObject(val)) ||
            (t === "array" && Array.isArray(val)) ||
            (t === "string" && typeof val === "string") ||
            (t === "number" && typeof val === "number") ||
            (t === "boolean" && typeof val === "boolean") ||
            (t === "null" && val === null);
          return ok ? "Yes" : "No";
        }
        case "Const":
          return JSON.stringify(val) === JSON.stringify(ir.value)
            ? "Yes"
            : "No";
        case "Enum":
          return ir.values.some((x: any) =>
              JSON.stringify(x) === JSON.stringify(val)
            )
            ? "Yes"
            : "No";
        case "Range": {
          if (typeof val !== "number") return "No";
          if (ir.min !== undefined) {
            if (
              ir.exclMin ? !(val > ir.min) : !(val >= ir.min)
            ) return "No";
          }
          if (ir.max !== undefined) {
            if (
              ir.exclMax ? !(val < ir.max) : !(val <= ir.max)
            ) return "No";
          }
          return "Yes";
        }
        case "Pattern":
          return typeof val === "string" && ir.re.test(val) ? "Yes" : "No";
        case "Props": {
          if (!isObject(val)) return "No";
          for (const r of ir.required) {
            const has = Object.prototype.hasOwnProperty.call(val, r);
            readLink(key.doc, child(key.path, r));
            if (!has) return "No";
          }
          for (const [name, childIR] of ir.props.entries()) {
            const childPath = child(key.path, name);
            readLink(key.doc, childPath);
            const childKey: EvalKey = {
              ir: childIR,
              doc: key.doc,
              path: childPath,
              budget: key.budget,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at).verdict;
            if (res !== "Yes") return res;
          }
          if (ir.additional.mode === "omit") return "Yes";
          for (const n of Object.keys(val)) {
            if (ir.props.has(n)) continue;
            const childPath = child(key.path, n);
            readLink(key.doc, childPath);
            if (ir.additional.mode === "true") continue;
            const childKey: EvalKey = {
              ir: ir.additional.ir,
              doc: key.doc,
              path: childPath,
              budget: key.budget,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at).verdict;
            if (res !== "Yes") return res;
          }
          return "Yes";
        }
        case "Items": {
          if (!Array.isArray(val)) return "No";
          const len = this.storage.listItemsCount(key.doc, key.path, at);
          readLink(key.doc, child(key.path, "length"));
          if (ir.tuple) {
            for (let i = 0; i < ir.tuple.length && i < len; i++) {
              const childPath = child(key.path, String(i));
              readLink(key.doc, childPath);
              const childKey: EvalKey = {
                ir: ir.tuple[i],
                doc: key.doc,
                path: childPath,
                budget: key.budget,
              };
              deps.add(childKey);
              const res = this.evaluate(childKey, at).verdict;
              if (res !== "Yes") return res;
            }
            return "Yes";
          } else if (ir.item) {
            for (let i = 0; i < len; i++) {
              const childPath = child(key.path, String(i));
              readLink(key.doc, childPath);
              const childKey: EvalKey = {
                ir: ir.item,
                doc: key.doc,
                path: childPath,
                budget: key.budget,
              };
              deps.add(childKey);
              const res = this.evaluate(childKey, at).verdict;
              if (res !== "Yes") return res;
            }
            return "Yes";
          }
          return "Yes";
        }
        case "AllOf": {
          for (const n of ir.nodes) {
            const childKey: EvalKey = {
              ir: n,
              doc: key.doc,
              path: key.path,
              budget: key.budget,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at).verdict;
            if (res !== "Yes") return res;
          }
          return "Yes";
        }
        case "AnyOf": {
          let sawMaybe = false;
          for (const n of ir.nodes) {
            const childKey: EvalKey = {
              ir: n,
              doc: key.doc,
              path: key.path,
              budget: key.budget,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at).verdict;
            if (res === "Yes") return "Yes";
            if (res === "MaybeExceededDepth") sawMaybe = true;
          }
          return sawMaybe ? "MaybeExceededDepth" : "No";
        }
      }
    };

    let verdict = descend(key.ir, v);

    if (isLinkValue(v)) {
      if (key.budget <= 0) {
        verdict = verdict === "Yes" ? "MaybeExceededDepth" : verdict;
      } else {
        const tgt = v["/"]["link@1"];
        const from: Link = { doc: key.doc, path: key.path };
        const to: Link = { doc: tgt.id, path: toTokens(tgt.path) };
        linkEdges.add({ from, to });
        const ekStr = Provenance.keyEval(key);
        const toKey = Provenance.keyLink(to);
        if (!this.prov.linkEdges.has(ekStr)) {
          this.prov.linkEdges.set(ekStr, new Set());
        }
        this.prov.linkEdges.get(ekStr)!.add(toKey);
        const childKey: EvalKey = {
          ir: key.ir,
          doc: tgt.id,
          path: toTokens(tgt.path),
          budget: key.budget - 1,
        };
        deps.add(childKey);
        const res = this.evaluate(childKey, at).verdict;
        if (res === "No") verdict = "No";
        else if (
          res === "MaybeExceededDepth" || verdict === "MaybeExceededDepth"
        ) verdict = "MaybeExceededDepth";
        else verdict = "Yes";
      }
    }

    const result: EvalResult = { verdict, touches, linkEdges, deps };
    this.memo.set(ek, result);

    for (const l of touches) {
      const lk = Provenance.keyLink(l);
      if (!this.prov.linkToEval.has(lk)) {
        this.prov.linkToEval.set(lk, new Set());
      }
      this.prov.linkToEval.get(lk)!.add(ek);
    }
    for (const child of deps) {
      const p = ek;
      const c = Provenance.keyEval(child);
      if (!this.prov.evalChildren.has(p)) {
        this.prov.evalChildren.set(p, new Set());
      }
      if (!this.prov.evalParents.has(c)) {
        this.prov.evalParents.set(c, new Set());
      }
      this.prov.evalChildren.get(p)!.add(c);
      this.prov.evalParents.get(c)!.add(p);
    }

    return result;
  }
}
