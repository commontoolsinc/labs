// Evaluate IRPlan using PIT and simple JSON traversal
// This is a lightweight evaluator aimed at unit tests and does not persist provenance to DB.

import { getAutomergeBytesAtSeq } from "./pit.ts";
import * as Automerge from "npm:@automerge/automerge";
import type { Database } from "@db/sqlite";
import type { IRPlan, IRNode, SourceNode, FilterOp, Link, LinkEdge } from "./query_ir.ts";

export type EvalRow = {
  doc: string;
  path: string[];
  value: any;
  // provenance
  touches: Set<string>; // serialized link keys "doc|path/json"
  linkEdges: LinkEdge[];
};

export interface EvalOptions {
  db: Database;
  // per-doc branchId and seq to read, default to current heads
  branchIdByDoc?: Record<string, string>;
  seqByDoc?: Record<string, number>;
}

function linkKey(doc: string, path: string[]): string {
  return `${doc}|${JSON.stringify(path)}`;
}

export function evaluatePlan(plan: IRPlan, opts: EvalOptions): EvalRow[] {
  // Load all source docs at the requested seq
  let rows: EvalRow[] = [];
  for (const docId of plan.source.docs) {
    const branchId = opts.branchIdByDoc?.[docId] ?? inferBranchId(opts.db, docId);
    const seq = opts.seqByDoc?.[docId] ?? inferSeq(opts.db, docId, branchId);
    const bytes = getAutomergeBytesAtSeq(opts.db, null, docId, branchId, seq);
    const json = Automerge.toJS(Automerge.load(bytes));
    const startPath = plan.source.path ?? [];
    const value = getAtPath(json, startPath);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const itemPath = [...startPath, String(i)];
        const t = new Set<string>();
        t.add(linkKey(docId, itemPath));
        rows.push({ doc: docId, path: itemPath, value: value[i], touches: t, linkEdges: [] });
      }
    } else {
      const t = new Set<string>();
      t.add(linkKey(docId, startPath));
      rows.push({ doc: docId, path: startPath, value, touches: t, linkEdges: [] });
    }
  }

  // Global budget
  let globalBudget = Infinity;
  const budgetNode = plan.steps.find((s) => s.kind === "Budget") as any;
  if (budgetNode) globalBudget = budgetNode.linkBudget;

  for (const step of plan.steps) {
    switch (step.kind) {
      case "Budget":
        // already handled
        continue;
      case "Filter":
        rows = rows.filter((r) => applyFilter(r.value, step.op));
        break;
      case "Project":
        rows = rows.map((r) => ({ ...r, value: projectFields(r.value, step.fields) }));
        break;
      case "Sort":
        // stable sort by decorating with index
        rows = rows.map((r, i) => ({ r, i }))
          .sort((a, b) => compareBy(a.r.value, b.r.value, step.by) || a.i - b.i)
          .map((x) => x.r);
        break;
      case "Limit":
        {
          const offset = step.offset ?? 0;
          rows = rows.slice(offset, offset + step.limit);
        }
        break;
      case "Join":
        rows = rows.flatMap((r) => joinVia(r, step.via, step.as, step.select, opts, () => {
          if (globalBudget <= 0) return false;
          globalBudget -= 1;
          return true;
        }));
        break;
      case "Traverse":
        rows = rows.flatMap((r) => traverseVia(r, step.via, step.depth, !!step.accumulate, opts, () => {
          if (globalBudget <= 0) return false;
          globalBudget -= 1;
          return true;
        }));
        break;
      default:
        throw new Error(`Unknown IR step ${(step as IRNode).kind}`);
    }
  }

  return rows;
}

function applyFilter(obj: any, op: FilterOp): boolean {
  const v = getAtPathByDot(obj, op.field);
  switch (op.kind) {
    case "eq":
      return v === (op as any).value;
    case "ne":
      return v !== (op as any).value;
    case "gt":
      return v > (op as any).value;
    case "gte":
      return v >= (op as any).value;
    case "lt":
      return v < (op as any).value;
    case "lte":
      return v <= (op as any).value;
    case "in":
      return Array.isArray((op as any).value) && (op as any).value.includes(v);
    case "contains":
      return Array.isArray(v) ? v.includes((op as any).value) : typeof v === "string" ? v.includes((op as any).value) : false;
    default:
      return true;
  }
}

function projectFields(obj: any, fields: string[]): any {
  if (!fields || fields.length === 0) return obj;
  const out: any = {};
  for (const f of fields) {
    setAtPathByDot(out, f, getAtPathByDot(obj, f));
  }
  return out;
}

function compareBy(a: any, b: any, keys: { field: string; order?: "asc" | "desc" }[]): number {
  for (const k of keys) {
    const av = getAtPathByDot(a, k.field);
    const bv = getAtPathByDot(b, k.field);
    const cmp = av === bv ? 0 : av < bv ? -1 : 1;
    if (cmp !== 0) return (k.order ?? "asc") === "asc" ? cmp : -cmp;
  }
  return 0;
}

function getAtPath(root: any, path: string[]): any {
  let cur = root;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function getAtPathByDot(root: any, dotPath: string): any {
  return getAtPath(root, dotPath.split(".").filter((s) => s.length > 0));
}

function setAtPathByDot(root: any, dotPath: string, value: any): void {
  const segs = dotPath.split(".").filter((s) => s.length > 0);
  let cur = root as any;
  for (let i = 0; i < segs.length; i++) {
    const k = segs[i]!;
    const last = i === segs.length - 1;
    if (last) cur[k] = value; else {
      if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
  }
}

function inferBranchId(db: Database, docId: string): string {
  const row = db.prepare(
    `SELECT branch_id FROM branches WHERE doc_id = :doc_id AND name = 'main'`
  ).get({ doc_id: docId }) as { branch_id: string } | undefined;
  if (!row) throw new Error(`no branch for doc ${docId}`);
  return row.branch_id;
}

function inferSeq(db: Database, docId: string, branchId: string): number {
  const row = db.prepare(
    `SELECT seq_no FROM am_heads WHERE branch_id = :branch_id`
  ).get({ branch_id: branchId }) as { seq_no: number } | undefined;
  if (!row) return 0;
  return row.seq_no;
}

function asLinks(x: any): { doc: string; path: string[] }[] {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : [x];
  return arr.filter((v) => v && typeof v === "object" && typeof v.doc === "string" && Array.isArray(v.path));
}

function joinVia(row: EvalRow, via: string, as: string | undefined, select: string[] | undefined, opts: EvalOptions, consumeBudget: () => boolean): EvalRow[] {
  const links = asLinks(getAtPathByDot(row.value, via));
  if (links.length === 0) return [];
  const out: EvalRow[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const key = linkKey(l.doc, l.path);
    if (seen.has(key)) continue; // de-dupe
    seen.add(key);
    if (!consumeBudget()) break;
    // read target doc
    const branchId = inferBranchId(opts.db, l.doc);
    const seq = inferSeq(opts.db, l.doc, branchId);
    const bytes = getAutomergeBytesAtSeq(opts.db, null, l.doc, branchId, seq);
    const json = Automerge.toJS(Automerge.load(bytes));
    const value = getAtPath(json, l.path);
    const touches = new Set(row.touches);
    touches.add(linkKey(row.doc, row.path));
    touches.add(linkKey(l.doc, l.path));
    const joined = select && select.length > 0 ? projectFields(value, select) : value;
    const merged = as ? { ...row.value, [as]: joined } : { ...row.value, ...joined };
    out.push({ doc: l.doc, path: l.path, value: merged, touches, linkEdges: [...row.linkEdges, { from: { doc: row.doc, path: row.path }, to: { doc: l.doc, path: l.path } }] });
  }
  return out;
}

function traverseVia(row: EvalRow, via: string, depth: number, accumulate: boolean, opts: EvalOptions, consumeBudget: () => boolean): EvalRow[] {
  const result: EvalRow[] = [];
  const visited = new Set<string>();
  function dfs(doc: string, path: string[], value: any, d: number) {
    const key = linkKey(doc, path);
    if (visited.has(key)) return;
    visited.add(key);
    const links = asLinks(getAtPathByDot(value, via));
    const isLeaf = d === 0 || links.length === 0;
    if (accumulate || isLeaf) {
      result.push({ doc, path, value, touches: new Set(row.touches).add(key), linkEdges: [] });
    }
    if (d === 0) return;
    for (const l of links) {
      if (!consumeBudget()) return;
      const branchId = inferBranchId(opts.db, l.doc);
      const seq = inferSeq(opts.db, l.doc, branchId);
      const bytes = getAutomergeBytesAtSeq(opts.db, null, l.doc, branchId, seq);
      const json = Automerge.toJS(Automerge.load(bytes));
      const v = getAtPath(json, l.path);
      dfs(l.doc, l.path, v, d - 1);
    }
  }
  dfs(row.doc, row.path, row.value, depth);
  return result.length > 0 ? result : [row];
}

