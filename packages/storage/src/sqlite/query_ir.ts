// Query IR for document queries over storage
// Node kinds: Source, Filter, Project, Sort, Limit, Join, Traverse, Budget

export type DocId = string;
export type Path = string[];

export type Link = { doc: DocId; path: Path };
export type LinkEdge = { from: Link; to: Link };

export type SortOrder = "asc" | "desc";

export type SourceNode = {
  kind: "Source";
  // Explicit list of root documents to start from
  docs: DocId[];
  // Optional starting path inside each doc (default: [])
  path?: Path;
};

export type FilterOp =
  | { kind: "eq"; field: string; value: any }
  | { kind: "ne"; field: string; value: any }
  | { kind: "gt"; field: string; value: any }
  | { kind: "gte"; field: string; value: any }
  | { kind: "lt"; field: string; value: any }
  | { kind: "lte"; field: string; value: any }
  | { kind: "in"; field: string; value: any[] }
  | { kind: "contains"; field: string; value: any };

export type FilterNode = {
  kind: "Filter";
  op: FilterOp;
};

export type ProjectNode = {
  kind: "Project";
  // Field names (dot paths) to include; if empty, include all
  fields: string[];
};

export type SortNode = {
  kind: "Sort";
  by: { field: string; order?: SortOrder }[];
};

export type LimitNode = {
  kind: "Limit";
  limit: number;
  offset?: number;
};

export type JoinNode = {
  kind: "Join";
  // Field on the current row that holds a link or array of links
  via: string; // dot path
  as?: string; // prefix for joined fields
  // Optional projection of joined document
  select?: string[];
};

export type TraverseNode = {
  kind: "Traverse";
  // Field on the current row that holds link(s) to traverse repeatedly
  via: string; // dot path
  // Maximum depth to traverse from this node (non-negative)
  depth: number;
  // If true, accumulate all visited nodes; if false, only leaves
  accumulate?: boolean;
};

export type BudgetNode = {
  kind: "Budget";
  // Global link-follow budget (caps all traversals/joins)
  linkBudget: number;
};

export type IRNode =
  | SourceNode
  | FilterNode
  | ProjectNode
  | SortNode
  | LimitNode
  | JoinNode
  | TraverseNode
  | BudgetNode;

export type IRPlan = {
  source: SourceNode;
  steps: IRNode[]; // sequence applied after source; includes Budget optionally
};

// User query type compiled into IRPlan
export type UserQuery = {
  source: { docs: DocId[]; path?: Path };
  filter?: FilterOp;
  project?: string[];
  sort?: { field: string; order?: SortOrder }[];
  limit?: { limit: number; offset?: number };
  join?: { via: string; as?: string; select?: string[] };
  traverse?: { via: string; depth: number; accumulate?: boolean };
  budget?: { linkBudget: number };
};

export function compileQuery(q: UserQuery): IRPlan {
  // Basic validations inspired by §§09–12: non-negative budgets, defined fields
  if (!q?.source?.docs || q.source.docs.length === 0) {
    throw new Error("source.docs must be non-empty");
  }
  if (q.limit) {
    if (q.limit.limit < 0) throw new Error("limit must be >= 0");
    if (q.limit.offset != null && q.limit.offset < 0) {
      throw new Error("offset must be >= 0");
    }
  }
  if (q.traverse) {
    if (q.traverse.depth < 0) throw new Error("traverse.depth must be >= 0");
    if (!q.traverse.via) throw new Error("traverse.via is required");
  }
  if (q.join) {
    if (!q.join.via) throw new Error("join.via is required");
  }
  if (q.budget && q.budget.linkBudget < 0) {
    throw new Error("budget.linkBudget must be >= 0");
  }

  const steps: IRNode[] = [];
  if (q.budget) steps.push({ kind: "Budget", linkBudget: q.budget.linkBudget });
  if (q.filter) steps.push({ kind: "Filter", op: q.filter });
  if (q.join) {
    steps.push({
      kind: "Join",
      via: q.join.via,
      as: q.join.as,
      select: q.join.select,
    });
  }
  if (q.traverse) {
    steps.push({
      kind: "Traverse",
      via: q.traverse.via,
      depth: q.traverse.depth,
      accumulate: q.traverse.accumulate,
    });
  }
  if (q.project) steps.push({ kind: "Project", fields: q.project });
  if (q.sort) steps.push({ kind: "Sort", by: q.sort });
  if (q.limit) {
    steps.push({ kind: "Limit", limit: q.limit.limit, offset: q.limit.offset });
  }

  return {
    source: { kind: "Source", docs: q.source.docs, path: q.source.path ?? [] },
    steps,
  };
}
