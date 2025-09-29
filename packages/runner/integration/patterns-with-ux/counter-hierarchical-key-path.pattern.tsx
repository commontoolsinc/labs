/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
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

const updateAtPath = (
  path: HierarchicalPath,
  amount: number,
  context: {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
  },
) => {
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
};

const incrementNorthAlpha = handler<
  unknown,
  {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
  }
>((_event, context) => {
  const path: HierarchicalPath = [
    "clusters",
    "north",
    "nodes",
    0,
    "metrics",
    "alpha",
  ];
  updateAtPath(path, 1, context);
});

const incrementNorthBeta = handler<
  unknown,
  {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
  }
>((_event, context) => {
  const path: HierarchicalPath = [
    "clusters",
    "north",
    "nodes",
    0,
    "metrics",
    "beta",
  ];
  updateAtPath(path, 1, context);
});

const incrementSouthAlpha = handler<
  unknown,
  {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
  }
>((_event, context) => {
  const path: HierarchicalPath = [
    "clusters",
    "south",
    "nodes",
    0,
    "metrics",
    "alpha",
  ];
  updateAtPath(path, 1, context);
});

const incrementSouthBeta = handler<
  unknown,
  {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
  }
>((_event, context) => {
  const path: HierarchicalPath = [
    "clusters",
    "south",
    "nodes",
    0,
    "metrics",
    "beta",
  ];
  updateAtPath(path, 1, context);
});

const incrementCustomPath = handler<
  unknown,
  {
    hierarchy: Cell<HierarchyState>;
    updateCount: Cell<number>;
    pathLog: Cell<string[]>;
    lastPath: Cell<string>;
    pathInput: Cell<string>;
    amountInput: Cell<string>;
  }
>((_event, context) => {
  const pathStr = context.pathInput.get();
  const amountStr = context.amountInput.get();

  const pathSegments = pathStr
    .split(".")
    .map((seg) => {
      const asNumber = Number(seg);
      return Number.isNaN(asNumber) ? seg : asNumber;
    })
    .filter((seg) => seg !== "");

  const path = normalizePath(pathSegments);
  const amount = Number(amountStr) || 1;

  updateAtPath(path, amount, context);
});

/** Pattern updating nested counters by traversing key paths. */
export const counterWithHierarchicalKeyPath = recipe<HierarchyArgs>(
  "Counter With Hierarchical Key Path",
  ({ hierarchy }) => {
    const updateCount = cell(0);
    const lastPath = cell(DEFAULT_PATH_STRING);
    const pathLog = cell<string[]>([]);

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

    // UI cells for path construction
    const pathInput = cell("");
    const amountInput = cell("1");

    // Derived values for display
    const hierarchyDisplay = lift((state: HierarchyState | undefined) => {
      if (!state || !state.clusters) return <div>No data</div>;

      return (
        <div style="display: flex; flex-direction: column; gap: 16px;">
          {Object.entries(state.clusters).map(([clusterName, cluster]) => {
            const nodes = Array.isArray(cluster?.nodes) ? cluster.nodes : [];
            const nodeElements = nodes.map((node, index) => {
              const metrics = node?.metrics ?? { alpha: 0, beta: 0 };
              const alpha = toNumber(metrics.alpha);
              const beta = toNumber(metrics.beta);
              const nodeTotal = alpha + beta;

              return (
                <div
                  key={String(index)}
                  style="background: #f8f9fa; border-radius: 6px; padding: 12px; margin-top: 8px;"
                >
                  <div style="font-weight: 600; margin-bottom: 8px; color: #495057;">
                    Node {String(index)}
                  </div>
                  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px;">
                    <div>
                      <div style="font-size: 12px; color: #868e96; margin-bottom: 4px;">
                        Alpha
                      </div>
                      <div style="font-size: 20px; font-weight: 600; color: #228be6;">
                        {String(alpha)}
                      </div>
                    </div>
                    <div>
                      <div style="font-size: 12px; color: #868e96; margin-bottom: 4px;">
                        Beta
                      </div>
                      <div style="font-size: 20px; font-weight: 600; color: #7950f2;">
                        {String(beta)}
                      </div>
                    </div>
                    <div>
                      <div style="font-size: 12px; color: #868e96; margin-bottom: 4px;">
                        Total
                      </div>
                      <div style="font-size: 20px; font-weight: 600; color: #495057;">
                        {String(nodeTotal)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            });

            const clusterColor = clusterName === "north"
              ? "#228be6"
              : "#f03e3e";

            return (
              <ct-card key={clusterName}>
                <div style="padding: 16px;">
                  <div
                    style={"display: flex; align-items: center; gap: 8px; margin-bottom: 12px; border-left: 4px solid " +
                      clusterColor + "; padding-left: 12px;"}
                  >
                    <span
                      style={"display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: " +
                        clusterColor + ";"}
                    />
                    <span style="font-size: 18px; font-weight: 700; color: #212529; text-transform: uppercase;">
                      {clusterName}
                    </span>
                  </div>
                  {nodeElements}
                </div>
              </ct-card>
            );
          })}
        </div>
      );
    })(hierarchy);

    const pathLogDisplay = lift((log: string[]) => {
      if (!Array.isArray(log) || log.length === 0) {
        return (
          <div style="padding: 16px; color: #868e96; text-align: center;">
            No updates yet
          </div>
        );
      }

      const recentLog = log.slice(-10).reverse();
      return (
        <div style="display: flex; flex-direction: column; gap: 8px;">
          {recentLog.map((path, index) => (
            <div
              key={String(index)}
              style="background: #f8f9fa; border-radius: 6px; padding: 10px 12px; font-family: monospace; font-size: 13px; color: #495057; border-left: 3px solid #228be6;"
            >
              {path}
            </div>
          ))}
        </div>
      );
    })(pathLogView);

    const name = str`Hierarchical Key Path (${updates} updates)`;

    const ui = (
      <div style="max-width: 1200px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
            Hierarchical Key Path Counter
          </h1>
          <p style="margin: 0; font-size: 14px; opacity: 0.95;">
            Traverse nested structures dynamically using key paths to update
            deeply nested counters
          </p>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
          <ct-card>
            <div style="padding: 16px;">
              <div style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #212529;">
                📊 Summary
              </div>
              <div style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                  <div style="font-size: 12px; color: #868e96; margin-bottom: 4px;">
                    Total Updates
                  </div>
                  <div style="font-size: 32px; font-weight: 700; color: #667eea;">
                    {updates}
                  </div>
                </div>
                <div>
                  <div style="font-size: 12px; color: #868e96; margin-bottom: 4px;">
                    Overall Sum
                  </div>
                  <div style="font-size: 32px; font-weight: 700; color: #228be6;">
                    {overall}
                  </div>
                </div>
                <div>
                  <div style="font-size: 12px; color: #868e96; margin-bottom: 6px;">
                    Last Updated Path
                  </div>
                  <div style="font-family: monospace; font-size: 13px; background: #f8f9fa; padding: 10px; border-radius: 6px; color: #495057; word-break: break-all;">
                    {lastUpdatedPath}
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div style="padding: 16px;">
              <div style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #212529;">
                ⚡ Quick Actions
              </div>
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <ct-button
                  onClick={incrementNorthAlpha({
                    hierarchy,
                    updateCount,
                    pathLog,
                    lastPath,
                  })}
                  style="background: #228be6; color: white;"
                >
                  +1 North Alpha
                </ct-button>
                <ct-button
                  onClick={incrementNorthBeta({
                    hierarchy,
                    updateCount,
                    pathLog,
                    lastPath,
                  })}
                  style="background: #7950f2; color: white;"
                >
                  +1 North Beta
                </ct-button>
                <ct-button
                  onClick={incrementSouthAlpha({
                    hierarchy,
                    updateCount,
                    pathLog,
                    lastPath,
                  })}
                  style="background: #f03e3e; color: white;"
                >
                  +1 South Alpha
                </ct-button>
                <ct-button
                  onClick={incrementSouthBeta({
                    hierarchy,
                    updateCount,
                    pathLog,
                    lastPath,
                  })}
                  style="background: #fa5252; color: white;"
                >
                  +1 South Beta
                </ct-button>
              </div>
            </div>
          </ct-card>
        </div>

        <ct-card>
          <div style="padding: 16px;">
            <div style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #212529;">
              🎯 Custom Path Update
            </div>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <div>
                <label style="display: block; font-size: 13px; font-weight: 600; color: #495057; margin-bottom: 6px;">
                  Key Path (dot-separated)
                </label>
                <ct-input
                  $value={pathInput}
                  placeholder="north.nodes.0.metrics.alpha"
                  style="width: 100%; font-family: monospace;"
                />
                <div style="font-size: 12px; color: #868e96; margin-top: 4px;">
                  Example: north.nodes.0.metrics.alpha or
                  south.nodes.0.metrics.beta
                </div>
              </div>
              <div>
                <label style="display: block; font-size: 13px; font-weight: 600; color: #495057; margin-bottom: 6px;">
                  Amount
                </label>
                <ct-input
                  $value={amountInput}
                  placeholder="1"
                  style="width: 200px;"
                />
              </div>
              <ct-button
                onClick={incrementCustomPath({
                  hierarchy,
                  updateCount,
                  pathLog,
                  lastPath,
                  pathInput,
                  amountInput,
                })}
                style="background: #667eea; color: white; align-self: flex-start;"
              >
                Apply Custom Update
              </ct-button>
            </div>
          </div>
        </ct-card>

        <div style="margin-top: 24px;">
          <div style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #212529;">
            🏗️ Hierarchy State
          </div>
          {hierarchyDisplay}
        </div>

        <ct-card style="margin-top: 24px;">
          <div style="padding: 16px;">
            <div style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #212529;">
              📜 Update Log (Recent 10)
            </div>
            {pathLogDisplay}
          </div>
        </ct-card>
      </div>
    );

    return {
      hierarchy,
      totals,
      overall,
      updates,
      lastUpdatedPath,
      pathLog: pathLogView,
      label,
      defaultPath: DEFAULT_PATH_STRING,
      adjust: updateHierarchicalCounter({
        hierarchy,
        updateCount,
        pathLog,
        lastPath,
      }),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
