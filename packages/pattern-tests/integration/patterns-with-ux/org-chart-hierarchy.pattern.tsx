/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface OrgMember {
  id: string;
  name: string;
  manager: string | null;
}

interface OrgChartArgs {
  members: Default<OrgMember[], typeof defaultMembers>;
}

interface OrgChartNode {
  id: string;
  name: string;
  reports: OrgChartNode[];
}

interface RelocateEvent {
  employeeId?: string;
  newManagerId?: string | null;
}

const defaultMembers: OrgMember[] = [
  { id: "ceo", name: "Avery CEO", manager: null },
  { id: "cto", name: "Casey CTO", manager: "ceo" },
  { id: "eng-lead", name: "Riley Eng Lead", manager: "cto" },
  { id: "designer", name: "Sky Designer", manager: "eng-lead" },
  { id: "ops", name: "Morgan Ops", manager: "ceo" },
];

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const baseMemberList = (value: unknown): OrgMember[] => {
  if (!Array.isArray(value)) {
    return structuredClone(defaultMembers);
  }
  const seen = new Set<string>();
  const members: OrgMember[] = [];
  for (const entry of value) {
    const candidate = entry as OrgMember | undefined;
    const id = sanitizeId(candidate?.id);
    if (!id || seen.has(id)) continue;
    const name = sanitizeName(candidate?.name, id);
    const managerValue = candidate?.manager;
    const manager = typeof managerValue === "string"
      ? sanitizeId(managerValue)
      : managerValue === null
      ? null
      : null;
    members.push({ id, name, manager });
    seen.add(id);
  }
  if (members.length === 0) {
    return structuredClone(defaultMembers);
  }
  return members;
};

const resolveCycles = (members: readonly OrgMember[]): OrgMember[] => {
  const parent = new Map<string, string | null>();
  for (const member of members) {
    parent.set(member.id, member.manager);
  }
  for (const member of members) {
    const origin = member.id;
    const visited = new Set<string>([origin]);
    let current = parent.get(origin) ?? null;
    while (current) {
      if (!parent.has(current) || visited.has(current)) {
        parent.set(origin, null);
        break;
      }
      visited.add(current);
      current = parent.get(current) ?? null;
    }
  }
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    manager: parent.get(member.id) ?? null,
  }));
};

const sanitizeMembers = (value: unknown): OrgMember[] => {
  const base = baseMemberList(value);
  const ids = new Set(base.map((member) => member.id));
  const validated = base.map((member) => {
    if (!member.manager) {
      return { ...member, manager: null };
    }
    if (!ids.has(member.manager) || member.manager === member.id) {
      return { ...member, manager: null };
    }
    return member;
  });
  if (!validated.some((member) => member.manager === null)) {
    validated[0] = { ...validated[0], manager: null };
  }
  const resolved = resolveCycles(validated);
  return resolved
    .map((member) => ({ ...member }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

const buildHierarchy = (members: readonly OrgMember[]): OrgChartNode[] => {
  const nodes = new Map<string, OrgChartNode>();
  for (const member of members) {
    nodes.set(member.id, {
      id: member.id,
      name: member.name,
      reports: [],
    });
  }
  const roots: OrgChartNode[] = [];
  for (const member of members) {
    const node = nodes.get(member.id);
    if (!node) continue;
    if (member.manager && nodes.has(member.manager)) {
      nodes.get(member.manager)?.reports.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortTree = (list: OrgChartNode[]) => {
    list.sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of list) {
      sortTree(entry.reports);
    }
  };
  sortTree(roots);
  return roots;
};

const buildReportingChains = (
  members: readonly OrgMember[],
): Record<string, string[]> => {
  const byId = new Map<string, OrgMember>();
  for (const member of members) {
    byId.set(member.id, member);
  }
  const cache = new Map<string, string[]>();
  const resolve = (memberId: string): string[] => {
    const cached = cache.get(memberId);
    if (cached) return [...cached];
    const names: string[] = [];
    const visited = new Set<string>();
    let current: string | null = memberId;
    let guard = 0;
    while (current && guard <= members.length) {
      if (visited.has(current)) break;
      visited.add(current);
      const member = byId.get(current);
      if (!member) break;
      names.push(member.name);
      current = member.manager;
      guard += 1;
    }
    const chain = names.reverse();
    cache.set(memberId, chain);
    return [...chain];
  };
  const entries: [string, string[]][] = [];
  for (const member of members) {
    entries.push([member.id, resolve(member.id)]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries.map(([id, chain]) => [id, [...chain]]));
};

const createsCycle = (
  members: readonly OrgMember[],
  employeeId: string,
  candidateManager: string,
): boolean => {
  const children = new Map<string, string[]>();
  for (const member of members) {
    if (!member.manager) continue;
    const list = children.get(member.manager) ?? [];
    list.push(member.id);
    children.set(member.manager, list);
  }
  const queue = [...(children.get(employeeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === candidateManager) return true;
    const next = children.get(current);
    if (next && next.length > 0) {
      queue.push(...next);
    }
  }
  return false;
};

export const orgChartHierarchyUx = recipe<OrgChartArgs>(
  "Org Chart Hierarchy (UX)",
  ({ members }) => {
    const history = cell<string[]>([]);

    const memberList = lift((value: OrgMember[] | undefined) =>
      sanitizeMembers(value)
    )(members);

    const hierarchy = lift(buildHierarchy)(memberList);
    const reportingChains = lift(buildReportingChains)(memberList);
    const topLevelNames = lift((nodes: OrgChartNode[]) =>
      nodes.map((node) => node.name)
    )(hierarchy);
    const memberCount = lift((entries: OrgMember[]) => entries.length)(
      memberList,
    );
    const rootCount = lift((nodes: OrgChartNode[]) => nodes.length)(hierarchy);
    const summary =
      str`Org has ${memberCount} members across ${rootCount} root nodes`;
    const chainSummaries = lift((chains: Record<string, string[]>) =>
      Object.entries(chains)
        .map(([id, chain]) => `${id}: ${chain.join(" > ")}`)
        .sort((left, right) => left.localeCompare(right))
    )(reportingChains);

    const selectedEmployeeId = cell<string>("");
    const selectedManagerId = cell<string>("");

    const performRelocate = handler<
      unknown,
      {
        members: Cell<OrgMember[]>;
        history: Cell<string[]>;
        employeeId: Cell<string>;
        managerId: Cell<string>;
      }
    >((_event, { members, history, employeeId, managerId }) => {
      const empId = sanitizeId(employeeId.get());
      if (!empId) return;

      const rawMembers = members.get();
      const sanitized = sanitizeMembers(rawMembers);
      const employee = sanitized.find((entry) => entry.id === empId);
      if (!employee) return;

      const rawManagerId = managerId.get();
      let nextManager: string | null;
      if (rawManagerId === "" || rawManagerId === "null") {
        nextManager = null;
      } else {
        const sanitizedManager = sanitizeId(rawManagerId);
        if (!sanitizedManager) return;
        nextManager = sanitizedManager;
      }

      if (nextManager === employee.manager) return;

      const ids = new Set(sanitized.map((member) => member.id));
      if (nextManager) {
        if (!ids.has(nextManager) || nextManager === empId) return;
        if (createsCycle(sanitized, empId, nextManager)) return;
      }

      const updated = sanitized.map((member) =>
        member.id === empId ? { ...member, manager: nextManager } : member
      );
      const canonical = sanitizeMembers(updated);

      const nameById = new Map(
        sanitized.map((member) => [member.id, member.name]),
      );
      const previousManagerName = employee.manager
        ? nameById.get(employee.manager) ?? "Top Level"
        : "Top Level";
      const targetManagerName = nextManager
        ? nameById.get(nextManager) ?? "Top Level"
        : "Top Level";

      members.set(canonical);

      const log = history.get();
      const message =
        `Relocated ${employee.name} from ${previousManagerName} to ` +
        `${nextManager ? targetManagerName : "Top Level"}`;
      history.set([...log, message]);
    })({
      members,
      history,
      employeeId: selectedEmployeeId,
      managerId: selectedManagerId,
    });

    const managerOptions = lift((allMembers: OrgMember[]) => {
      const options: Array<{ id: string; name: string }> = [
        { id: "null", name: "Top Level (No Manager)" },
      ];
      for (const member of allMembers) {
        options.push({ id: member.id, name: member.name });
      }
      return options;
    })(memberList);

    const name = str`Org Chart (${memberCount} members)`;

    const renderOrgNode = (
      node: OrgChartNode,
      level: number,
    ): JSX.Element => {
      const indent = level * 1.5;
      return (
        <div style={`margin-left: ${indent}rem;`}>
          <div style="
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              border-radius: 0.5rem;
              padding: 0.75rem 1rem;
              margin-bottom: 0.5rem;
              color: white;
              font-weight: 500;
              box-shadow: 0 2px 4px rgba(102, 126, 234, 0.2);
            ">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>{node.name}</span>
              <span style="
                  font-size: 0.7rem;
                  opacity: 0.8;
                  font-weight: 400;
                  letter-spacing: 0.05em;
                ">
                {node.id}
              </span>
            </div>
            {node.reports.length > 0 && (
              <div style="
                  font-size: 0.7rem;
                  margin-top: 0.25rem;
                  opacity: 0.9;
                ">
                {node.reports.length} direct report
                {node.reports.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          {node.reports.map((report) => renderOrgNode(report, level + 1))}
        </div>
      );
    };

    return {
      members,
      hierarchy,
      reportingChains,
      topLevelNames,
      summary,
      chainSummaries,
      history,
      relocate: performRelocate,
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Organization Chart
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Visualize and manage reporting structure
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <span style="font-weight: 600; color: #1e293b;">
                    Organization Overview
                  </span>
                </div>
                <div style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                  ">
                  <div style="
                      background: white;
                      border-radius: 0.5rem;
                      padding: 0.75rem;
                      border: 1px solid #e2e8f0;
                    ">
                    <div style="font-size: 0.7rem; color: #64748b; margin-bottom: 0.25rem;">
                      Total Members
                    </div>
                    <div style="font-size: 1.5rem; font-weight: 700; color: #667eea;">
                      {memberCount}
                    </div>
                  </div>
                  <div style="
                      background: white;
                      border-radius: 0.5rem;
                      padding: 0.75rem;
                      border: 1px solid #e2e8f0;
                    ">
                    <div style="font-size: 0.7rem; color: #64748b; margin-bottom: 0.25rem;">
                      Top Level Leads
                    </div>
                    <div style="font-size: 1.5rem; font-weight: 700; color: #764ba2;">
                      {rootCount}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">Organizational Hierarchy</div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                max-height: 30rem;
                overflow-y: auto;
                padding: 0.5rem;
              "
            >
              {lift((nodes: OrgChartNode[]) => {
                if (nodes.length === 0) {
                  return (
                    <div style="text-align: center; color: #94a3b8; padding: 2rem;">
                      No organization members found
                    </div>
                  );
                }
                return nodes.map((node) => renderOrgNode(node, 0));
              })(hierarchy)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">Relocate Employee</div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                <label style="
                    font-size: 0.8rem;
                    font-weight: 500;
                    color: #475569;
                  ">
                  Select Employee
                </label>
                <select
                  $value={selectedEmployeeId}
                  style="
                    padding: 0.625rem;
                    border: 1px solid #cbd5e1;
                    border-radius: 0.5rem;
                    font-size: 0.875rem;
                    background: white;
                  "
                >
                  <option value="">-- Choose an employee --</option>
                  {lift((allMembers: OrgMember[]) =>
                    allMembers.map((member) => (
                      <option value={member.id}>
                        {member.name} ({member.id})
                      </option>
                    ))
                  )(memberList)}
                </select>
              </div>

              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                <label style="
                    font-size: 0.8rem;
                    font-weight: 500;
                    color: #475569;
                  ">
                  New Manager
                </label>
                <select
                  $value={selectedManagerId}
                  style="
                    padding: 0.625rem;
                    border: 1px solid #cbd5e1;
                    border-radius: 0.5rem;
                    font-size: 0.875rem;
                    background: white;
                  "
                >
                  <option value="">-- Choose a new manager --</option>
                  {lift((options: Array<{ id: string; name: string }>) =>
                    options.map((option) => (
                      <option value={option.id}>{option.name}</option>
                    ))
                  )(managerOptions)}
                </select>
              </div>

              <ct-button onClick={performRelocate} variant="primary">
                Relocate Employee
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">Reporting Chains</div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 20rem;
                overflow-y: auto;
                font-size: 0.8rem;
              "
            >
              {lift((summaries: string[]) => {
                if (summaries.length === 0) {
                  return (
                    <div style="text-align: center; color: #94a3b8; padding: 1rem;">
                      No reporting chains available
                    </div>
                  );
                }
                return summaries.map((summary) => (
                  <div style="
                      padding: 0.5rem 0.75rem;
                      background: #f8fafc;
                      border-radius: 0.375rem;
                      border-left: 3px solid #667eea;
                      font-family: monospace;
                    ">
                    {summary}
                  </div>
                ));
              })(chainSummaries)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">Activity History</div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 15rem;
                overflow-y: auto;
              "
            >
              {lift((entries: string[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="text-align: center; color: #94a3b8; padding: 1rem;">
                      No activity yet
                    </div>
                  );
                }
                return entries
                  .slice()
                  .reverse()
                  .map((entry, idx) => (
                    <div style="
                        padding: 0.625rem 0.875rem;
                        background: #f1f5f9;
                        border-radius: 0.375rem;
                        font-size: 0.8rem;
                        color: #334155;
                      ">
                      <span style="font-weight: 600; color: #667eea;">
                        #{entries.length - idx}
                      </span>{" "}
                      {entry}
                    </div>
                  ));
              })(history)}
            </div>
          </ct-card>
        </div>
      ),
    };
  },
);

export default orgChartHierarchyUx;
