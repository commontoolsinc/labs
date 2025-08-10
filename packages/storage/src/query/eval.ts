import { DocId, Link, Path, Verdict, Version } from "./types.ts";
import { IRId, IRPool } from "./ir.ts";
import { Storage } from "./storage.ts";
import { child } from "./path.ts";

export const DEFAULT_VISIT_LIMIT = 16_384;

export type EvalKey = { ir: IRId; doc: DocId; path: Path };
export type EvalResult = {
  verdict: Verdict;
  touches: Set<Link>;
  linkEdges: Set<{ from: Link; to: Link }>;
  deps: Set<EvalKey>;
};

function isObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

export type LinkValue = { "/": { "link@1": { id: DocId; path: string[] } } };

export function isLinkValue(v: any): v is LinkValue {
  return (
    isObject(v) &&
    isObject(v["/"]) &&
    isObject(v["/"]["link@1"]) &&
    typeof v["/"]["link@1"].id === "string" &&
    Array.isArray(v["/"]["link@1"].path)
  );
}

export class Provenance {
  linkToEval = new Map<string, Set<string>>();
  evalParents = new Map<string, Set<string>>();
  evalChildren = new Map<string, Set<string>>();
  linkEdges = new Map<string, Set<string>>();

  static keyLink(c: Link): string {
    return `${c.doc}\u0001${JSON.stringify(c.path)}`;
  }
  static keyEval(k: EvalKey): string {
    return `${k.ir}\u0001${k.doc}\u0001${JSON.stringify(k.path)}`;
  }
}

export type VisitContext = {
  seenIRDocPath: Set<string>;
  valueMemo: Map<string, any>;
};

export class Evaluator {
  constructor(
    private pool: IRPool,
    private storage: Storage,
    private prov: Provenance,
    private options: { visitLimit?: number } = {},
  ) {}
  memo = new Map<string, EvalResult>();

  newContext(): VisitContext {
    return {
      seenIRDocPath: new Set<string>(),
      valueMemo: new Map<string, any>(),
    };
  }

  private get visitLimit(): number {
    return this.options.visitLimit ?? DEFAULT_VISIT_LIMIT;
  }

  // Follow links encountered while consuming targetPath starting from (baseDoc, basePath).
  // Records touches for each child step (parent/seg) and linkEdges for each hop.
  private normalizePath(
    baseDoc: DocId,
    basePath: Path,
    targetPath: Path,
    at: Version | undefined,
    ctx: VisitContext,
    touches: Set<Link>,
    linkEdges: Set<{ from: Link; to: Link }>,
    ekStr: string,
  ): { doc: DocId; path: Path } {
    let curDoc = baseDoc;
    let curPath: Path = [];

    // Bring curPath up to basePath, touching each step and following links encountered
    for (const seg of basePath) {
      const next = child(curPath, seg);
      const l = { doc: curDoc, path: next } as Link;
      touches.add(l);
      const lk = Provenance.keyLink(l);
      if (!this.prov.linkToEval.has(lk)) {
        this.prov.linkToEval.set(lk, new Set());
      }
      this.prov.linkToEval.get(lk)!.add(ekStr);

      curPath = next;
      while (true) {
        const memoKey = `${curDoc}\u0001${JSON.stringify(curPath)}\u0001${
          JSON.stringify(at ?? {})
        }`;
        let val = ctx.valueMemo.get(memoKey);
        if (val === undefined) {
          val = this.storage.read(curDoc, curPath, at);
          ctx.valueMemo.set(memoKey, val);
        }
        if (!isLinkValue(val)) break;
        const tgt = val["/"]["link@1"];
        const to: Link = { doc: tgt.id, path: tgt.path };
        const from: Link = { doc: curDoc, path: curPath };
        linkEdges.add({ from, to });
        const toKey = Provenance.keyLink(to);
        if (!this.prov.linkEdges.has(ekStr)) {
          this.prov.linkEdges.set(ekStr, new Set());
        }
        this.prov.linkEdges.get(ekStr)!.add(toKey);
        curDoc = to.doc;
        curPath = to.path;
      }
    }

    // Now consume the remaining targetPath segments from base
    const remaining = [...targetPath];
    while (remaining.length > 0) {
      // Follow links at current location before stepping into next segment
      while (true) {
        const memoKey = `${curDoc}\u0001${JSON.stringify(curPath)}\u0001${
          JSON.stringify(at ?? {})
        }`;
        let val = ctx.valueMemo.get(memoKey);
        if (val === undefined) {
          val = this.storage.read(curDoc, curPath, at);
          ctx.valueMemo.set(memoKey, val);
        }
        if (!isLinkValue(val)) break;
        const tgt = val["/"]["link@1"];
        const to: Link = { doc: tgt.id, path: tgt.path };
        const from: Link = { doc: curDoc, path: curPath };
        linkEdges.add({ from, to });
        const toKey = Provenance.keyLink(to);
        if (!this.prov.linkEdges.has(ekStr)) {
          this.prov.linkEdges.set(ekStr, new Set());
        }
        this.prov.linkEdges.get(ekStr)!.add(toKey);
        curDoc = to.doc;
        curPath = to.path;
      }
      const seg = remaining.shift()!;
      const next = child(curPath, seg);
      const l = { doc: curDoc, path: next } as Link;
      touches.add(l);
      const lk = Provenance.keyLink(l);
      if (!this.prov.linkToEval.has(lk)) {
        this.prov.linkToEval.set(lk, new Set());
      }
      this.prov.linkToEval.get(lk)!.add(ekStr);
      curPath = next;
    }

    return { doc: curDoc, path: curPath };
  }

  evaluate(key: EvalKey, at?: Version, ctx?: VisitContext): EvalResult {
    if (!ctx) ctx = this.newContext();
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

    // Anchor touch on the original key path
    readLink(key.doc, key.path);

    // Normalize path by following links encountered along the path tokens
    const norm = this.normalizePath(
      key.doc,
      [],
      key.path,
      at,
      ctx!,
      touches,
      linkEdges,
      ek,
    );
    const effDoc = norm.doc;
    const effPath = norm.path;

    const memoKey = `${effDoc}\u0001${JSON.stringify(effPath)}\u0001${
      JSON.stringify(at ?? {})
    }`;
    let v = ctx.valueMemo.get(memoKey);
    if (v === undefined) {
      v = this.storage.read(effDoc, effPath, at);
      ctx.valueMemo.set(memoKey, v);
    }

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
            if (ir.exclMin ? !(val > ir.min) : !(val >= ir.min)) return "No";
          }
          if (ir.max !== undefined) {
            if (ir.exclMax ? !(val < ir.max) : !(val <= ir.max)) return "No";
          }
          return "Yes";
        }
        case "Pattern":
          return typeof val === "string" && ir.re.test(val) ? "Yes" : "No";
        case "Props": {
          if (!isObject(val)) return "No";
          for (const r of ir.required) {
            const has = Object.prototype.hasOwnProperty.call(val, r);
            readLink(effDoc, child(effPath, r));
            if (!has) return "No";
          }
          for (const [name, childIR] of ir.props.entries()) {
            if (!Object.prototype.hasOwnProperty.call(val, name)) continue;
            const childPath = child(effPath, name);
            readLink(effDoc, childPath);
            const childKey: EvalKey = {
              ir: childIR,
              doc: effDoc,
              path: childPath,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at, ctx).verdict;
            if (res !== "Yes") return res;
          }
          if (ir.additional.mode === "omit") return "Yes";
          for (const n of Object.keys(val)) {
            if (ir.props.has(n)) continue;
            const childPath = child(effPath, n);
            readLink(effDoc, childPath);
            if (ir.additional.mode === "true") continue;
            const childKey: EvalKey = {
              ir: ir.additional.ir,
              doc: effDoc,
              path: childPath,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at, ctx).verdict;
            if (res !== "Yes") return res;
          }
          return "Yes";
        }
        case "Items": {
          if (!Array.isArray(val)) return "No";
          // We intentionally avoid listItemsCount here; the production adapter can override.
          const len = Array.isArray(val) ? val.length : 0;
          if (ir.tuple) {
            for (let i = 0; i < ir.tuple.length && i < len; i++) {
              const childPath = child(effPath, String(i));
              readLink(effDoc, childPath);
              const childKey: EvalKey = {
                ir: ir.tuple[i],
                doc: effDoc,
                path: childPath,
              };
              deps.add(childKey);
              const res = this.evaluate(childKey, at, ctx).verdict;
              if (res !== "Yes") return res;
            }
            return "Yes";
          } else if (ir.item) {
            for (let i = 0; i < len; i++) {
              const childPath = child(effPath, String(i));
              readLink(effDoc, childPath);
              const childKey: EvalKey = {
                ir: ir.item,
                doc: effDoc,
                path: childPath,
              };
              deps.add(childKey);
              const res = this.evaluate(childKey, at, ctx).verdict;
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
              doc: effDoc,
              path: effPath,
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at, ctx).verdict;
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
            };
            deps.add(childKey);
            const res = this.evaluate(childKey, at, ctx).verdict;
            if (res === "Yes") return "Yes";
            if (res === "MaybeExceededDepth") sawMaybe = true;
          }
          return sawMaybe ? "MaybeExceededDepth" : "No";
        }
      }
    };

    let verdict = descend(key.ir, v);

    if (isLinkValue(v)) {
      const tgt = v["/"]["link@1"];
      const to: Link = { doc: tgt.id, path: tgt.path };
      const from: Link = { doc: effDoc, path: effPath };

      // record edge for explainability/provenance
      linkEdges.add({ from, to });
      const ekStr = Provenance.keyEval(key);
      const toKey = Provenance.keyLink(to);
      if (!this.prov.linkEdges.has(ekStr)) {
        this.prov.linkEdges.set(ekStr, new Set());
      }
      this.prov.linkEdges.get(ekStr)!.add(toKey);

      const visitKey = `${key.ir}\u0001${to.doc}\u0001${
        JSON.stringify(to.path)
      }`;
      if (ctx.seenIRDocPath.has(visitKey)) {
        // Proper cycle revisit at same (IR, doc, path): do not recurse.
        const result: EvalResult = { verdict, touches, linkEdges, deps };

        // Attach provenance edges for touches/deps we actually recorded:
        for (const lnk of touches) {
          const lk = Provenance.keyLink(lnk);
          if (!this.prov.linkToEval.has(lk)) {
            this.prov.linkToEval.set(lk, new Set());
          }
          this.prov.linkToEval.get(lk)!.add(ekStr);
        }
        for (const child of deps) {
          const p = ekStr, c = Provenance.keyEval(child);
          if (!this.prov.evalChildren.has(p)) {
            this.prov.evalChildren.set(p, new Set());
          }
          if (!this.prov.evalParents.has(c)) {
            this.prov.evalParents.set(c, new Set());
          }
          this.prov.evalChildren.get(p)!.add(c);
          this.prov.evalParents.get(c)!.add(p);
        }
        return result; // no memo on context-specific short-circuit
      }

      // First time visiting this (IR, doc, path) in this evaluation
      if (ctx.seenIRDocPath.size >= this.visitLimit) {
        verdict = verdict === "Yes" ? "MaybeExceededDepth" : verdict;
      } else {
        ctx.seenIRDocPath.add(visitKey);
        const childKey: EvalKey = { ir: key.ir, doc: to.doc, path: to.path };
        deps.add(childKey);
        const res = this.evaluate(childKey, at, ctx).verdict;
        if (res === "No") verdict = "No";
        else if (
          res === "MaybeExceededDepth" || verdict === "MaybeExceededDepth"
        ) verdict = "MaybeExceededDepth";
        else verdict = "Yes";
        ctx.seenIRDocPath.delete(visitKey);
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
