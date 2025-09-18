/// <cts-enable />
import {
  type Cell,
  cell,
  createCell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

type HierarchicalPath = Array<string | number>;

interface NodeMetrics {
  alpha: number;
  beta: number;
}

interface NodeState {
  metrics: NodeMetrics;
}

interface ClusterState {
  nodes: NodeState[];
}

interface HierarchyState {
  clusters: Record<string, ClusterState>;
}

/** Arguments for the hierarchical key path counter pattern. */
interface HierarchyArgs {
  hierarchy: Default<
    HierarchyState,
    {
      clusters: {
        north: { nodes: [{ metrics: { alpha: 0; beta: 0 } }] };
        south: { nodes: [{ metrics: { alpha: 0; beta: 0 } }] };
      };
    }
  >;
}

interface HierarchyUpdateEvent {
  path?: HierarchicalPath;
  amount?: number;
}

const DEFAULT_PATH: HierarchicalPath = [
  "clusters",
  "north",
  "nodes",
  0,
  "metrics",
  "alpha",
];

const DEFAULT_PATH_STRING = DEFAULT_PATH
  .map((segment) => String(segment))
  .join(".");

const normalizePath = (
  path: HierarchicalPath | undefined,
): HierarchicalPath => {
  if (!Array.isArray(path)) return DEFAULT_PATH;
  const cleaned = path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || Number.isInteger(segment),
  );
  if (cleaned.length === 0) return DEFAULT_PATH;
  if (cleaned[0] !== "clusters") {
    return ["clusters", ...cleaned];
  }
  return cleaned;
};

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : 0;

const computeClusterTotals = (
  state: HierarchyState | undefined,
): Record<string, number> => {
  const clusters = state?.clusters;
  if (!clusters || typeof clusters !== "object") return {};
  const summary: Record<string, number> = {};
  for (const [key, cluster] of Object.entries(clusters)) {
    const nodes = Array.isArray(cluster?.nodes) ? cluster.nodes : [];
    const total = nodes.reduce((sum, node) => {
      const metrics = node?.metrics ?? {};
      return sum + toNumber(metrics.alpha) + toNumber(metrics.beta);
    }, 0);
    summary[key] = total;
  }
  return summary;
};

const sumTotals = (summary: Record<string, number>): number => {
  return Object.values(summary).reduce((sum, value) => sum + value, 0);
};

const clampPathLog = (entries: string[] | undefined): string[] => {
  return Array.isArray(entries) ? entries : [];
};

const updateHierarchicalCounter = handler(
  (
    event: HierarchyUpdateEvent | undefined,
    context: {
      hierarchy: Cell<HierarchyState>;
      updateCount: Cell<number>;
      pathLog: Cell<string[]>;
      lastPath: Cell<string>;
    },
  ) => {
    const path = normalizePath(event?.path);
    const amount = typeof event?.amount === "number" ? event.amount : 1;

    let current: Cell<unknown> = context.hierarchy as Cell<unknown>;
    const recordedPath: string[] = [];
    for (const key of path) {
      current = (current as Cell<Record<PropertyKey, unknown>>).key(
        key as never,
      );
      recordedPath.push(String(key));
    }

    const leaf = current as Cell<number>;
    const base = toNumber(leaf.get());
    leaf.set(base + amount);

    const previous = toNumber(context.updateCount.get());
    context.updateCount.set(previous + 1);

    const joined = recordedPath.join(".");
    context.lastPath.set(joined);

    const existing = context.pathLog.get();
    const entries = Array.isArray(existing) ? existing.slice() : [];
    entries.push(joined);
    context.pathLog.set(entries);
  },
);

/** Pattern updating nested counters by traversing key paths. */
export const counterWithHierarchicalKeyPath = recipe<HierarchyArgs>(
  "Counter With Hierarchical Key Path",
  ({ hierarchy }) => {
    const updateCount = cell(0);
    const lastPath = cell(DEFAULT_PATH_STRING);
    const pathLog = cell<string[]>([]);
    const defaultPathSeed = cell(true);
    const defaultPathCell = lift(() =>
      createCell(
        { type: "string" },
        "hierarchicalDefaultPath",
        DEFAULT_PATH_STRING,
      )
    )(defaultPathSeed);

    const totals = derive(hierarchy, computeClusterTotals);
    const overall = lift(sumTotals)(totals);
    const updates = lift((count: number | undefined) => count ?? 0)(
      updateCount,
    );
    const lastUpdatedPath = lift(
      (value: string | undefined) => value ?? DEFAULT_PATH_STRING,
    )(lastPath);
    const pathLogView = lift(clampPathLog)(pathLog);
    const label = str`${updates} updates via ${lastUpdatedPath}`;

    return {
      hierarchy,
      totals,
      overall,
      updates,
      lastUpdatedPath,
      pathLog: pathLogView,
      label,
      defaultPath: defaultPathCell,
      adjust: updateHierarchicalCounter({
        hierarchy,
        updateCount,
        pathLog,
        lastPath,
      }),
    };
  },
);
