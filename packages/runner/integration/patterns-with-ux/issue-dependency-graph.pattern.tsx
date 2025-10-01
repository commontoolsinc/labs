/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface IssueInput {
  id: string;
  title?: string;
  dependencies?: string[];
}

interface IssueDependencyArgs {
  issues: Default<IssueInput[], []>;
}

interface Issue {
  id: string;
  title: string;
  dependencies: string[];
}

type RejectionReason = "missing" | "self" | "cycle";

interface RejectedEdge {
  from: string;
  to: string;
  reason: RejectionReason;
}

interface GraphDetails {
  adjacency: Record<string, string[]>;
  order: string[];
  roots: string[];
  blocked: string[];
  hasCycle: boolean;
}

interface GraphContext {
  source: Cell<IssueInput[]>;
  rejected: Cell<RejectedEdge[]>;
}

interface UIContext extends GraphContext {
  newIssueId: Cell<string>;
  newIssueTitle: Cell<string>;
  newIssueDeps: Cell<string>;
  linkFromId: Cell<string>;
  linkToId: Cell<string>;
  unlinkFromId: Cell<string>;
  unlinkToId: Cell<string>;
}

const normalizeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const extractDependencyList = (value: unknown, selfId: string): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    const dependency = normalizeId(candidate);
    if (!dependency) continue;
    if (dependency === selfId) continue;
    if (result.includes(dependency)) continue;
    result.push(dependency);
  }
  return result;
};

const sanitizeIssueList = (value: unknown): Issue[] => {
  if (!Array.isArray(value)) return [];
  const raw: Issue[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = normalizeId((entry as IssueInput).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = normalizeTitle((entry as IssueInput).title, id);
    const dependencies = extractDependencyList(
      (entry as IssueInput).dependencies,
      id,
    );
    raw.push({ id, title, dependencies });
  }
  const knownIds = new Set(raw.map((item) => item.id));
  return raw.map((item) => ({
    id: item.id,
    title: item.title,
    dependencies: item.dependencies.filter((dep) => knownIds.has(dep)),
  }));
};

const prepareDependencyList = (
  dependencies: string[],
  knownIds: Set<string>,
  selfId: string,
): string[] => {
  const result: string[] = [];
  for (const candidate of dependencies) {
    const dependency = normalizeId(candidate);
    if (!dependency) continue;
    if (dependency === selfId) continue;
    if (!knownIds.has(dependency)) continue;
    if (result.includes(dependency)) continue;
    result.push(dependency);
  }
  return result;
};

const copyIssueForArgument = (issue: Issue): IssueInput => ({
  id: issue.id,
  title: issue.title,
  dependencies: issue.dependencies.slice(),
});

const recordRejection = (
  cellRef: Cell<RejectedEdge[]>,
  entry: RejectedEdge,
) => {
  const existing = cellRef.get();
  const history = Array.isArray(existing) ? existing.slice(-4) : [];
  history.push(entry);
  cellRef.set(history);
};

const commitIssues = (context: GraphContext, entries: Issue[]) => {
  context.source.set(entries.map(copyIssueForArgument));
};

const buildGraphDetails = (issues: Issue[]): GraphDetails => {
  const dependencyMap: Record<string, string[]> = {};
  const dependentMap: Record<string, string[]> = {};
  const indegree = new Map<string, number>();

  for (const issue of issues) {
    dependencyMap[issue.id] = [];
    dependentMap[issue.id] = [];
    indegree.set(issue.id, 0);
  }

  for (const issue of issues) {
    for (const dependency of issue.dependencies) {
      if (!indegree.has(dependency)) continue;
      dependencyMap[issue.id].push(dependency);
      dependentMap[dependency].push(issue.id);
      indegree.set(issue.id, (indegree.get(issue.id) ?? 0) + 1);
    }
  }

  const initialDegrees = new Map(indegree);
  const queue = Array.from(indegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) break;
    order.push(currentId);
    const dependents = dependentMap[currentId] ?? [];
    for (const dependent of dependents) {
      const nextDegree = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  const hasCycle = order.length !== issues.length;
  const blocked = hasCycle
    ? issues
      .map((issue) => issue.id)
      .filter((id) => !order.includes(id))
      .sort()
    : [];
  const roots = Array.from(initialDegrees.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  return { adjacency: dependencyMap, order, roots, blocked, hasCycle };
};

const wouldCreateCycle = (issues: Issue[]): boolean =>
  buildGraphDetails(issues).hasCycle;

const registerNewIssue = handler(
  (
    event:
      | { id?: string; title?: string; dependencies?: string[] }
      | undefined,
    context: GraphContext,
  ) => {
    const id = normalizeId(event?.id);
    if (!id) return;
    const current = sanitizeIssueList(context.source.get());
    if (current.some((issue) => issue.id === id)) return;
    const knownIds = new Set(current.map((issue) => issue.id));
    const dependencies = prepareDependencyList(
      extractDependencyList(event?.dependencies, id),
      knownIds,
      id,
    );
    const title = normalizeTitle(event?.title, id);
    const next = [...current, { id, title, dependencies }];
    commitIssues(context, next);
  },
);

const linkDependency = handler(
  (
    event: { from?: string; to?: string } | undefined,
    context: GraphContext,
  ) => {
    const from = normalizeId(event?.from);
    const to = normalizeId(event?.to);
    if (!from || !to) return;
    if (from === to) {
      recordRejection(context.rejected, { from, to, reason: "self" });
      return;
    }
    const current = sanitizeIssueList(context.source.get());
    const fromIndex = current.findIndex((issue) => issue.id === from);
    const toExists = current.some((issue) => issue.id === to);
    if (fromIndex === -1 || !toExists) {
      recordRejection(context.rejected, { from, to, reason: "missing" });
      return;
    }
    const knownIds = new Set(current.map((issue) => issue.id));
    const baseIssue = current[fromIndex];
    const mergedDependencies = [
      ...baseIssue.dependencies,
      to,
    ];
    const dependencies = prepareDependencyList(
      mergedDependencies,
      knownIds,
      from,
    );
    if (dependencies.length === baseIssue.dependencies.length) return;
    const next = current.slice();
    next[fromIndex] = { ...baseIssue, dependencies };
    if (wouldCreateCycle(next)) {
      recordRejection(context.rejected, { from, to, reason: "cycle" });
      return;
    }
    commitIssues(context, next);
  },
);

const unlinkDependency = handler(
  (
    event: { from?: string; to?: string } | undefined,
    context: GraphContext,
  ) => {
    const from = normalizeId(event?.from);
    const to = normalizeId(event?.to);
    if (!from || !to) return;
    const current = sanitizeIssueList(context.source.get());
    const fromIndex = current.findIndex((issue) => issue.id === from);
    if (fromIndex === -1) return;
    const baseIssue = current[fromIndex];
    if (!baseIssue.dependencies.includes(to)) return;
    const next = current.slice();
    next[fromIndex] = {
      ...baseIssue,
      dependencies: baseIssue.dependencies.filter((dep) => dep !== to),
    };
    commitIssues(context, next);
  },
);

export const issueDependencyGraph = recipe<IssueDependencyArgs>(
  "Issue Dependency Graph",
  ({ issues }) => {
    const rejectedEdges = cell<RejectedEdge[]>([]);

    const sanitizedIssues = lift(sanitizeIssueList)(issues);
    const issuesView = lift((entries: Issue[]) =>
      entries.map((issue) => ({
        id: issue.id,
        title: issue.title,
        dependencies: issue.dependencies.slice(),
      }))
    )(sanitizedIssues);
    const graphDetails = lift(buildGraphDetails)(sanitizedIssues);
    const adjacency = lift((details: GraphDetails) => {
      const result: Record<string, string[]> = {};
      for (const key of Object.keys(details.adjacency)) {
        result[key] = details.adjacency[key].slice();
      }
      return result;
    })(graphDetails);
    const order = lift((details: GraphDetails) => details.order.slice())(
      graphDetails,
    );
    const roots = lift((details: GraphDetails) => details.roots.slice())(
      graphDetails,
    );
    const blocked = lift((details: GraphDetails) => details.blocked.slice())(
      graphDetails,
    );
    const hasCycle = lift((details: GraphDetails) => details.hasCycle)(
      graphDetails,
    );
    const rejectionHistory = lift((entries: RejectedEdge[] | undefined) =>
      Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
    )(rejectedEdges);

    const orderText = lift((ids: string[]) =>
      ids.length > 0 ? ids.join(" → ") : "none"
    )(order);
    const cycleStatus = lift((flag: boolean) => flag ? "cycle" : "valid")(
      hasCycle,
    );
    const summary = str`${cycleStatus}: ${orderText}`;

    // UI-specific cells
    const newIssueId = cell("");
    const newIssueTitle = cell("");
    const newIssueDeps = cell("");
    const linkFromId = cell("");
    const linkToId = cell("");
    const unlinkFromId = cell("");
    const unlinkToId = cell("");

    // UI handlers
    const uiAddIssue = handler((_, context: UIContext) => {
      const id = normalizeId(context.newIssueId.get());
      const title = context.newIssueTitle.get();
      const depsStr = context.newIssueDeps.get();
      if (!id) return;

      const current = sanitizeIssueList(context.source.get());
      if (current.some((issue) => issue.id === id)) return;

      const knownIds = new Set(current.map((issue) => issue.id));
      const depsArray = typeof depsStr === "string" && depsStr.trim() !== ""
        ? depsStr.split(",").map((d) => d.trim()).filter((d) => d)
        : [];
      const dependencies = prepareDependencyList(depsArray, knownIds, id);
      const titleVal = normalizeTitle(title, id);
      const next = [...current, { id, title: titleVal, dependencies }];
      commitIssues(context, next);

      context.newIssueId.set("");
      context.newIssueTitle.set("");
      context.newIssueDeps.set("");
    });

    const uiLinkDependency = handler((_, context: UIContext) => {
      const from = normalizeId(context.linkFromId.get());
      const to = normalizeId(context.linkToId.get());
      if (!from || !to) return;
      if (from === to) {
        recordRejection(context.rejected, { from, to, reason: "self" });
        context.linkFromId.set("");
        context.linkToId.set("");
        return;
      }
      const current = sanitizeIssueList(context.source.get());
      const fromIndex = current.findIndex((issue) => issue.id === from);
      const toExists = current.some((issue) => issue.id === to);
      if (fromIndex === -1 || !toExists) {
        recordRejection(context.rejected, { from, to, reason: "missing" });
        context.linkFromId.set("");
        context.linkToId.set("");
        return;
      }
      const knownIds = new Set(current.map((issue) => issue.id));
      const baseIssue = current[fromIndex];
      const mergedDependencies = [...baseIssue.dependencies, to];
      const dependencies = prepareDependencyList(
        mergedDependencies,
        knownIds,
        from,
      );
      if (dependencies.length === baseIssue.dependencies.length) {
        context.linkFromId.set("");
        context.linkToId.set("");
        return;
      }
      const next = current.slice();
      next[fromIndex] = { ...baseIssue, dependencies };
      if (wouldCreateCycle(next)) {
        recordRejection(context.rejected, { from, to, reason: "cycle" });
        context.linkFromId.set("");
        context.linkToId.set("");
        return;
      }
      commitIssues(context, next);
      context.linkFromId.set("");
      context.linkToId.set("");
    });

    const uiUnlinkDependency = handler((_, context: UIContext) => {
      const from = normalizeId(context.unlinkFromId.get());
      const to = normalizeId(context.unlinkToId.get());
      if (!from || !to) return;
      const current = sanitizeIssueList(context.source.get());
      const fromIndex = current.findIndex((issue) => issue.id === from);
      if (fromIndex === -1) return;
      const baseIssue = current[fromIndex];
      if (!baseIssue.dependencies.includes(to)) return;
      const next = current.slice();
      next[fromIndex] = {
        ...baseIssue,
        dependencies: baseIssue.dependencies.filter((dep) => dep !== to),
      };
      commitIssues(context, next);
      context.unlinkFromId.set("");
      context.unlinkToId.set("");
    });

    // Name
    const name = lift((data: { iss: Issue[]; cycle: boolean }) => {
      const count = data.iss.length;
      const status = data.cycle ? "⚠️ Cycle" : "✓ Valid";
      return "Dependency Graph: " + String(count) + " issues (" + status + ")";
    })({ iss: sanitizedIssues, cycle: hasCycle });

    // UI
    const issueCards = lift(
      (data: { iss: Issue[]; adj: Record<string, string[]> }) => {
        const elements = [];
        for (const issue of data.iss) {
          const deps = data.adj[issue.id] || [];
          const depsStr = deps.length > 0 ? deps.join(", ") : "none";
          const card = h(
            "div",
            {
              style:
                "border: 1px solid #ddd; border-radius: 6px; padding: 12px; " +
                "background: white; margin-bottom: 8px;",
            },
            h(
              "div",
              {
                style: "font-weight: bold; font-size: 14px; color: #1e40af; " +
                  "margin-bottom: 4px;",
              },
              issue.title,
            ),
            h(
              "div",
              { style: "font-size: 12px; color: #6b7280; margin-bottom: 4px;" },
              "ID: " + issue.id,
            ),
            h(
              "div",
              { style: "font-size: 12px; color: #374151;" },
              "Dependencies: " + depsStr,
            ),
          );
          elements.push(card);
        }
        return h("div", {}, ...elements);
      },
    )({ iss: sanitizedIssues, adj: adjacency });

    const graphStatus = lift(
      (data: {
        cycle: boolean;
        rts: string[];
        blk: string[];
        ord: string[];
      }) => {
        const statusColor = data.cycle ? "#dc2626" : "#16a34a";
        const statusBg = data.cycle ? "#fef2f2" : "#f0fdf4";
        const statusText = data.cycle ? "CYCLE DETECTED" : "VALID GRAPH";

        const statusBadge = h(
          "div",
          {
            style:
              "display: inline-block; padding: 4px 12px; border-radius: 4px; " +
              "font-size: 12px; font-weight: bold; color: " +
              statusColor +
              "; " +
              "background: " +
              statusBg +
              "; border: 1px solid " +
              statusColor +
              ";",
          },
          statusText,
        );

        const rootsText = data.rts.length > 0 ? data.rts.join(", ") : "none";
        const orderText = data.ord.length > 0 ? data.ord.join(" → ") : "none";
        const blockedText = data.blk.length > 0 ? data.blk.join(", ") : "none";

        return h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); " +
              "padding: 16px; border-radius: 8px; color: white; " +
              "margin-bottom: 16px;",
          },
          h(
            "div",
            { style: "display: flex; align-items: center; gap: 12px;" },
            h(
              "div",
              { style: "font-size: 18px; font-weight: bold;" },
              "Graph Status",
            ),
            statusBadge,
          ),
          h(
            "div",
            { style: "margin-top: 12px; font-size: 13px;" },
            h("div", { style: "margin-bottom: 6px;" }, [
              h("strong", {}, "Roots: "),
              rootsText,
            ]),
            h("div", { style: "margin-bottom: 6px;" }, [
              h("strong", {}, "Execution Order: "),
              orderText,
            ]),
            data.cycle
              ? h("div", { style: "margin-bottom: 6px;" }, [
                h("strong", {}, "Blocked: "),
                blockedText,
              ])
              : null,
          ),
        );
      },
    )({ cycle: hasCycle, rts: roots, blk: blocked, ord: order });

    const rejectionLog = lift((hist: RejectedEdge[]) => {
      if (hist.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 12px; background: #f0fdf4; border: 1px dashed #16a34a; " +
              "border-radius: 6px; color: #15803d; font-size: 13px;",
          },
          "No rejections yet",
        );
      }

      const entries = [];
      const reversed = hist.slice().reverse();
      for (const entry of reversed) {
        const reasonLabel = entry.reason === "missing"
          ? "Missing issue"
          : entry.reason === "self"
          ? "Self reference"
          : "Would create cycle";
        const reasonColor = entry.reason === "cycle" ? "#dc2626" : "#f59e0b";

        entries.push(
          h(
            "div",
            {
              style:
                "padding: 8px; background: #fef2f2; border-left: 3px solid " +
                reasonColor +
                "; " +
                "margin-bottom: 6px; font-size: 12px;",
            },
            h("div", {}, [
              h("strong", {}, entry.from + " → " + entry.to),
              ": " + reasonLabel,
            ]),
          ),
        );
      }

      return h(
        "div",
        {},
        h(
          "div",
          {
            style: "font-weight: bold; font-size: 14px; margin-bottom: 8px; " +
              "color: #dc2626;",
          },
          "Recent Rejections",
        ),
        ...entries,
      );
    })(rejectionHistory);

    // Extract status, cards, and log as separate derived values
    const statusSection = graphStatus;
    const cardsSection = issueCards;
    const logSection = rejectionLog;

    const ui = (
      <div
        style={"font-family: system-ui, sans-serif; max-width: 900px; " +
          "margin: 0 auto; padding: 20px; background: #f9fafb;"}
      >
        {statusSection}
        <div
          style={"display: grid; grid-template-columns: 1fr 1fr; gap: 16px; " +
            "margin-bottom: 20px;"}
        >
          <div>
            <div
              style={"font-weight: bold; margin-bottom: 8px; color: #1f2937;"}
            >
              Add Issue
            </div>
            <ct-card style={"padding: 12px;"}>
              <ct-input
                placeholder="Issue ID"
                $value={newIssueId}
                style={"margin-bottom: 8px;"}
              />
              <ct-input
                placeholder="Title (optional)"
                $value={newIssueTitle}
                style={"margin-bottom: 8px;"}
              />
              <ct-input
                placeholder="Dependencies (comma-separated)"
                $value={newIssueDeps}
                style={"margin-bottom: 8px;"}
              />
              <ct-button
                onClick={uiAddIssue({
                  source: issues,
                  rejected: rejectedEdges,
                  newIssueId,
                  newIssueTitle,
                  newIssueDeps,
                })}
              >
                Add Issue
              </ct-button>
            </ct-card>
          </div>
          <div>
            <div
              style={"font-weight: bold; margin-bottom: 8px; color: #1f2937;"}
            >
              Manage Dependencies
            </div>
            <ct-card style={"padding: 12px; margin-bottom: 12px;"}>
              <div
                style={"font-size: 13px; font-weight: 600; margin-bottom: 6px;"}
              >
                Link
              </div>
              <ct-input
                placeholder="From ID"
                $value={linkFromId}
                style={"margin-bottom: 6px;"}
              />
              <ct-input
                placeholder="To ID"
                $value={linkToId}
                style={"margin-bottom: 6px;"}
              />
              <ct-button
                onClick={uiLinkDependency({
                  source: issues,
                  rejected: rejectedEdges,
                  linkFromId,
                  linkToId,
                })}
              >
                Add Dependency
              </ct-button>
            </ct-card>
            <ct-card style={"padding: 12px;"}>
              <div
                style={"font-size: 13px; font-weight: 600; margin-bottom: 6px;"}
              >
                Unlink
              </div>
              <ct-input
                placeholder="From ID"
                $value={unlinkFromId}
                style={"margin-bottom: 6px;"}
              />
              <ct-input
                placeholder="To ID"
                $value={unlinkToId}
                style={"margin-bottom: 6px;"}
              />
              <ct-button
                onClick={uiUnlinkDependency({
                  source: issues,
                  rejected: rejectedEdges,
                  unlinkFromId,
                  unlinkToId,
                })}
              >
                Remove Dependency
              </ct-button>
            </ct-card>
          </div>
        </div>
        <div style={"margin-bottom: 16px;"}>
          <div
            style={"font-weight: bold; font-size: 16px; margin-bottom: 8px; " +
              "color: #1f2937;"}
          >
            Issues
          </div>
          {cardsSection}
        </div>
        {logSection}
      </div>
    );

    return {
      issues: issuesView,
      adjacency,
      order,
      roots,
      blocked,
      hasCycle,
      summary,
      rejectionHistory,
      addIssue: registerNewIssue({
        source: issues,
        rejected: rejectedEdges,
      }),
      linkDependency: linkDependency({
        source: issues,
        rejected: rejectedEdges,
      }),
      unlinkDependency: unlinkDependency({
        source: issues,
        rejected: rejectedEdges,
      }),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
