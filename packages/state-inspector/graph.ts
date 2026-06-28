// The entity graph — the unified model made relational.
//
// Nodes are entities (pieces / modules / streams / schemas / cells) carrying the
// fluent label from model.ts. Edges are the real relationships:
//
//   pattern   piece  → module     (patternIdentity → the pattern source)
//   argument  piece  → input cell (the `argument` link)
//   owns      piece  → owned cell (the `internal` manifest)
//   link      entity → entity     (a data link inside `value`)
//
// One reconstruction pass builds everything: collect documents, build the module
// index inline (so `patternIdentity` resolves to a module node), classify each
// for its node, then read lineage + value links for edges. Data links may point
// across spaces; those are kept as `external` edges to a synthesized stub node
// (present:false) so the home→profile structure shows up here too, bounded.

import type { SpaceDb } from "./db.ts";
import { collectLinks } from "./decode.ts";
import { reconstructDocument } from "./reconstruct.ts";
import type { EntityDocument } from "./reconstruct.ts";
import {
  classifyDocument,
  type EntityKind,
  isModuleValue,
  modelFromDocument,
  type ModuleEntry,
} from "./model.ts";

export type EdgeKind = "pattern" | "argument" | "owns" | "link";

export interface GraphNode {
  id: string;
  kind: EntityKind;
  label: string;
  /** False for a synthesized stub (a cross-space link target not in this space). */
  present: boolean;
  /** Set on external stubs: the space DID the target lives in. */
  space?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Optional edge annotation (pattern symbol, link path, …). */
  label?: string;
  /** True when `to` lives in another space (a cross-space data link). */
  external?: boolean;
}

export interface SpaceGraph {
  space: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodesByKind: Record<string, number>;
    edgesByKind: Record<EdgeKind, number>;
    externalEdges: number;
  };
}

function shortPath(p?: readonly string[]): string | undefined {
  return p && p.length ? p.join("/") : undefined;
}

/**
 * Build the entity graph for a space. `includeLinks` (default true) adds data
 * links found inside each `value`; structural edges (pattern/argument/owns) are
 * always included.
 */
export function buildSpaceGraph(
  space: SpaceDb,
  opts: {
    branch?: string;
    scope?: string;
    limit?: number;
    includeLinks?: boolean;
  } = {},
): SpaceGraph {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 5000;
  const includeLinks = opts.includeLinks ?? true;
  const own = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");

  const rows = space.db
    .prepare(
      `SELECT id, count(*) revisions FROM revision
       WHERE branch = ? AND scope_key = ?
       GROUP BY id ORDER BY revisions DESC LIMIT ?`,
    )
    .all<{ id: string; revisions: number }>(branch, scope, limit);

  // Pass 1: reconstruct + build the module index (identity → module entity).
  const docs = new Map<string, EntityDocument>();
  const moduleIndex = new Map<string, ModuleEntry>();
  for (const r of rows) {
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, { id: r.id, branch, scope });
    } catch {
      doc = undefined;
    }
    if (!doc) continue;
    docs.set(r.id, doc);
    const v = doc.value;
    if (isModuleValue(v)) {
      const existing = moduleIndex.get(v.identity);
      if (!existing || v.kind === "source") {
        moduleIndex.set(v.identity, {
          id: r.id,
          filename: v.filename,
          kind: v.kind,
        });
      }
    }
  }

  // Pass 2: nodes + edges.
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const ensureStub = (id: string, space?: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "unknown",
        label: space ? "(external)" : "(absent)",
        present: false,
        space,
      });
    }
  };

  for (const [id, doc] of docs) {
    const m = modelFromDocument(doc, { id, scope, moduleIndex });
    nodes.set(id, { id, kind: m.kind, label: m.label, present: true });
  }

  for (const [id, doc] of docs) {
    const c = classifyDocument(doc);
    // pattern: piece → module (resolve patternIdentity via the module index;
    // classifyDocument leaves moduleId unset — that's modelFromDocument's job).
    const moduleId = c.lineage.pattern
      ? moduleIndex.get(c.lineage.pattern.identity)?.id
      : undefined;
    if (moduleId) {
      ensureStub(moduleId);
      edges.push({
        from: id,
        to: moduleId,
        kind: "pattern",
        label: c.lineage.pattern!.symbol,
      });
    }
    // argument: piece → input cell
    if (c.lineage.argument) {
      ensureStub(c.lineage.argument);
      edges.push({ from: id, to: c.lineage.argument, kind: "argument" });
    }
    // owns: piece → owned cells (internal manifest)
    for (const child of c.lineage.internal ?? []) {
      ensureStub(child);
      edges.push({ from: id, to: child, kind: "owns" });
    }
    // link: data links inside the value
    if (includeLinks) {
      for (const l of collectLinks(doc.value)) {
        if (!l.id) continue;
        const external = !!l.space && l.space !== own &&
          l.space !== `did:key:${own}`;
        if (external) ensureStub(l.id, l.space);
        else ensureStub(l.id);
        edges.push({
          from: id,
          to: l.id,
          kind: "link",
          label: shortPath(l.path),
          ...(external ? { external: true } : {}),
        });
      }
    }
  }

  // Dedup identical edges (same from/to/kind/label).
  const seen = new Set<string>();
  const deduped = edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.kind}|${e.label ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const nodesByKind: Record<string, number> = {};
  for (const n of nodes.values()) {
    nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
  }
  const edgesByKind: Record<EdgeKind, number> = {
    pattern: 0,
    argument: 0,
    owns: 0,
    link: 0,
  };
  let externalEdges = 0;
  for (const e of deduped) {
    edgesByKind[e.kind]++;
    if (e.external) externalEdges++;
  }

  return {
    space: own,
    nodes: [...nodes.values()],
    edges: deduped,
    stats: { nodesByKind, edgesByKind, externalEdges },
  };
}

/**
 * Restrict a graph to the connected neighborhood of `rootId` within `depth`
 * hops (following edges in both directions). For drilling into one piece.
 */
export function subgraphAround(
  graph: SpaceGraph,
  rootId: string,
  depth = 2,
): SpaceGraph {
  const adj = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of graph.edges) {
    touch(e.from, e.to);
    touch(e.to, e.from);
  }
  const keep = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!keep.has(m)) {
          keep.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const nodesByKind: Record<string, number> = {};
  for (const n of nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
  const edgesByKind: Record<EdgeKind, number> = {
    pattern: 0,
    argument: 0,
    owns: 0,
    link: 0,
  };
  let externalEdges = 0;
  for (const e of edges) {
    edgesByKind[e.kind]++;
    if (e.external) externalEdges++;
  }
  return {
    space: graph.space,
    nodes,
    edges,
    stats: { nodesByKind, edgesByKind, externalEdges },
  };
}

const DOT_FILL: Record<string, string> = {
  piece: "#fde68a",
  module: "#bfdbfe",
  stream: "#fbcfe8",
  schema: "#ddd6fe",
  "owned-cell": "#d1fae5",
  "free-cell": "#e5e7eb",
  unknown: "#f3f4f6",
};

const DOT_EDGE: Record<EdgeKind, string> = {
  pattern: 'color="#2563eb",style=bold',
  argument: 'color="#16a34a"',
  owns: 'color="#6b7280"',
  link: 'color="#9ca3af",style=dashed',
};

function dotId(id: string): string {
  return `"${id.replace(/"/g, "")}"`;
}

function dotLabel(n: GraphNode): string {
  const body = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
  const idTail = n.id.length > 12 ? n.id.slice(-8) : n.id;
  return `${n.kind}\\n${body}\\n${idTail}`.replace(/"/g, "'");
}

/** Render a graph as Graphviz DOT (pipe to `dot -Tsvg`). */
export function graphToDot(graph: SpaceGraph): string {
  const lines: string[] = [
    `digraph space {`,
    `  rankdir=LR;`,
    `  node [shape=box,style="filled,rounded",fontname="monospace",fontsize=9];`,
    `  edge [fontname="monospace",fontsize=8];`,
  ];
  for (const n of graph.nodes) {
    const fill = DOT_FILL[n.kind] ?? "#f3f4f6";
    const style = n.present ? "filled,rounded" : "filled,rounded,dashed";
    lines.push(
      `  ${dotId(n.id)} [label="${
        dotLabel(n)
      }",fillcolor="${fill}",style="${style}"];`,
    );
  }
  for (const e of graph.edges) {
    const attrs = DOT_EDGE[e.kind];
    const label = e.label ? `,label="${e.label.replace(/"/g, "'")}"` : "";
    lines.push(`  ${dotId(e.from)} -> ${dotId(e.to)} [${attrs}${label}];`);
  }
  lines.push(`}`);
  return lines.join("\n");
}
