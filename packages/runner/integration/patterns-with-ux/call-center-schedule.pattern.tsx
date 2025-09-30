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

interface SlotInput {
  id?: string;
  label?: string;
  requiredAgents?: number;
}

interface SlotDefinition {
  id: string;
  label: string;
  requiredAgents: number;
}

interface AgentInput {
  id?: string;
  name?: string;
}

interface AgentDefinition {
  id: string;
  name: string;
}

interface AssignmentInput {
  slot?: string;
  agent?: string;
}

interface AssignmentRecord {
  slot: string;
  agent: string;
}

interface SlotCoverage {
  slot: string;
  label: string;
  required: number;
  assigned: string[];
  assignedCount: number;
  remaining: number;
  hasGap: boolean;
}

interface ScheduleEvent {
  slot?: string;
  agent?: string;
  action?: "assign" | "unschedule";
}

interface LatestChange {
  sequence: number;
  slot: string;
  label: string;
  action: "assign" | "unschedule";
  agentId: string;
  agentName: string;
  gapCount: number;
  remaining: number;
}

interface CallCenterScheduleArgs {
  slots: Default<SlotInput[], typeof defaultSlots>;
  agents: Default<AgentInput[], typeof defaultAgents>;
  assignments: Default<AssignmentInput[], typeof defaultAssignments>;
}

const defaultSlots: SlotDefinition[] = [
  { id: "08:00-10:00", label: "Morning Block", requiredAgents: 1 },
  { id: "10:00-12:00", label: "Midday Block", requiredAgents: 1 },
  { id: "12:00-14:00", label: "Lunch Block", requiredAgents: 1 },
  { id: "14:00-16:00", label: "Afternoon Block", requiredAgents: 1 },
];

const defaultAgents: AgentDefinition[] = [
  { id: "alex-rivera", name: "Alex Rivera" },
  { id: "blair-chen", name: "Blair Chen" },
  { id: "casey-james", name: "Casey James" },
  { id: "drew-patel", name: "Drew Patel" },
];

const defaultAssignments: AssignmentRecord[] = [
  { slot: "08:00-10:00", agent: "alex-rivera" },
  { slot: "12:00-14:00", agent: "blair-chen" },
  { slot: "14:00-16:00", agent: "casey-james" },
];

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const normalizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizeSlotId = (
  value: unknown,
  fallback: string,
): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
};

const normalizeRequired = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const ensureUnique = (value: string, used: Set<string>): string => {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeSlots = (value: unknown): SlotDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultSlots);
  }
  const used = new Set<string>();
  const sanitized: SlotDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as SlotInput | undefined;
    const fallback = defaultSlots[index] ?? defaultSlots[0];
    const label = normalizeLabel(entry?.label, fallback.label);
    const idCandidate = entry?.id ?? label;
    const slotId = normalizeSlotId(idCandidate, fallback.id ?? label);
    if (!slotId) continue;
    const required = normalizeRequired(
      entry?.requiredAgents,
      fallback.requiredAgents,
    );
    const uniqueId = ensureUnique(slotId, used);
    sanitized.push({ id: uniqueId, label, requiredAgents: required });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultSlots);
  }
  return sanitized;
};

const normalizeAgentName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeAgents = (value: unknown): AgentDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultAgents);
  }
  const used = new Set<string>();
  const sanitized: AgentDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as AgentInput | undefined;
    const fallback = defaultAgents[index] ?? defaultAgents[0];
    const name = normalizeAgentName(entry?.name, fallback.name);
    const rawId = typeof entry?.id === "string" ? entry.id.trim() : "";
    const id = ensureUnique(
      slugify(rawId.length > 0 ? rawId : name),
      used,
    );
    sanitized.push({ id, name });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultAgents);
  }
  return sanitized;
};

const resolveSlotId = (
  slots: readonly SlotDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = slots.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byLabel = slots.find((entry) =>
    entry.label.toLowerCase() === normalized
  );
  return byLabel?.id ?? null;
};

const resolveAgentId = (
  agents: readonly AgentDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = agents.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byName = agents.find((entry) =>
    entry.name.toLowerCase() === normalized
  );
  return byName?.id ?? null;
};

const produceAssignments = (
  entries: readonly AssignmentInput[] | undefined,
  slots: readonly SlotDefinition[],
  agents: readonly AgentDefinition[],
): AssignmentRecord[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const order = new Map<string, number>();
  slots.forEach((slot, index) => order.set(slot.id, index));
  const agentOrder = new Map<string, number>();
  agents.forEach((agent, index) => agentOrder.set(agent.id, index));
  const seen = new Set<string>();
  const sanitized: AssignmentRecord[] = [];
  for (const entry of entries) {
    const slotId = resolveSlotId(slots, entry?.slot);
    const agentId = resolveAgentId(agents, entry?.agent);
    if (!slotId || !agentId) continue;
    const key = `${slotId}::${agentId}`;
    if (seen.has(key)) continue;
    sanitized.push({ slot: slotId, agent: agentId });
    seen.add(key);
  }
  sanitized.sort((left, right) => {
    const slotDiff = (order.get(left.slot) ?? 0) - (order.get(right.slot) ?? 0);
    if (slotDiff !== 0) return slotDiff;
    return (agentOrder.get(left.agent) ?? 0) -
      (agentOrder.get(right.agent) ?? 0);
  });
  return sanitized;
};

const buildCoverageEntries = (
  slots: readonly SlotDefinition[],
  assignments: readonly AssignmentRecord[],
  agents: readonly AgentDefinition[],
): SlotCoverage[] => {
  const agentNames = new Map<string, string>();
  for (const agent of agents) {
    agentNames.set(agent.id, agent.name);
  }
  const slotMap = new Map<string, SlotCoverage>();
  for (const slot of slots) {
    slotMap.set(slot.id, {
      slot: slot.id,
      label: slot.label,
      required: slot.requiredAgents,
      assigned: [],
      assignedCount: 0,
      remaining: slot.requiredAgents,
      hasGap: slot.requiredAgents > 0,
    });
  }
  for (const record of assignments) {
    const coverage = slotMap.get(record.slot);
    if (!coverage) continue;
    const name = agentNames.get(record.agent) ?? record.agent;
    coverage.assigned.push(name);
  }
  const coverageList: SlotCoverage[] = [];
  for (const slot of slots) {
    const coverage = slotMap.get(slot.id);
    if (!coverage) continue;
    coverage.assignedCount = coverage.assigned.length;
    const remaining = slot.requiredAgents - coverage.assignedCount;
    coverage.remaining = remaining > 0 ? remaining : 0;
    coverage.hasGap = coverage.remaining > 0;
    coverageList.push({ ...coverage, assigned: [...coverage.assigned] });
  }
  return coverageList;
};

const updateSchedule = handler(
  (
    event: ScheduleEvent | undefined,
    context: {
      assignments: Cell<AssignmentRecord[]>;
      baseSchedule: Cell<AssignmentRecord[]>;
      slots: Cell<SlotDefinition[]>;
      agents: Cell<AgentDefinition[]>;
      history: Cell<string[]>;
      latestChange: Cell<LatestChange | null>;
      sequence: Cell<number>;
    },
  ) => {
    const slots = context.slots.get() ?? [];
    const agents = context.agents.get() ?? [];
    if (slots.length === 0 || agents.length === 0) return;

    const slotId = resolveSlotId(slots, event?.slot);
    if (!slotId) return;

    const action = event?.action === "unschedule" ? "unschedule" : "assign";

    const storedRecords = context.assignments.get();
    const baseRecords = context.baseSchedule.get();
    const current = Array.isArray(storedRecords) && storedRecords.length > 0
      ? [...storedRecords]
      : Array.isArray(baseRecords)
      ? [...baseRecords]
      : [];
    const slotOrder = new Map<string, number>();
    slots.forEach((slot, index) => slotOrder.set(slot.id, index));
    const agentOrder = new Map<string, number>();
    agents.forEach((agent, index) => agentOrder.set(agent.id, index));

    let agentId = resolveAgentId(agents, event?.agent);

    if (action === "assign") {
      if (!agentId) return;
      if (
        current.some((entry) =>
          entry.slot === slotId && entry.agent === agentId
        )
      ) {
        return;
      }
      current.push({ slot: slotId, agent: agentId });
    } else {
      if (agentId) {
        const index = current.findIndex((entry) =>
          entry.slot === slotId && entry.agent === agentId
        );
        if (index === -1) return;
        current.splice(index, 1);
      } else {
        const index = current.findIndex((entry) => entry.slot === slotId);
        if (index === -1) return;
        const removed = current.splice(index, 1)[0];
        agentId = removed.agent;
      }
    }

    current.sort((left, right) => {
      const slotDiff = (slotOrder.get(left.slot) ?? 0) -
        (slotOrder.get(right.slot) ?? 0);
      if (slotDiff !== 0) return slotDiff;
      return (agentOrder.get(left.agent) ?? 0) -
        (agentOrder.get(right.agent) ?? 0);
    });

    const normalized = current.map((entry) => ({
      slot: entry.slot,
      agent: entry.agent,
    }));
    context.assignments.set(normalized);

    const coverage = buildCoverageEntries(slots, normalized, agents);
    const gapCount = coverage.reduce(
      (count, entry) => count + (entry.hasGap ? 1 : 0),
      0,
    );
    const coverageEntry = coverage.find((entry) => entry.slot === slotId);
    const slotLabel = coverageEntry?.label ?? slotId;
    const remaining = coverageEntry?.remaining ?? 0;

    const agentName = agentId
      ? agents.find((entry) => entry.id === agentId)?.name ?? agentId
      : "";
    const historyValue = context.history.get();
    const history = Array.isArray(historyValue) ? historyValue : [];
    const message = action === "assign"
      ? `Assigned ${agentName} to ${slotLabel}`
      : `Removed ${agentName} from ${slotLabel}`;
    context.history.set([...history, message]);

    const sequenceValue = context.sequence.get();
    const nextSequence = typeof sequenceValue === "number"
      ? sequenceValue + 1
      : 1;
    context.sequence.set(nextSequence);

    if (agentId) {
      context.latestChange.set({
        sequence: nextSequence,
        slot: slotId,
        label: slotLabel,
        action,
        agentId,
        agentName,
        gapCount,
        remaining,
      });
    }
  },
);

export const callCenterScheduleUx = recipe<CallCenterScheduleArgs>(
  "Call Center Schedule (UX)",
  ({ slots, agents, assignments }) => {
    const slotsList = lift(sanitizeSlots)(slots);
    const agentsList = lift(sanitizeAgents)(agents);

    const baseSchedule = lift((input: {
      entries: AssignmentInput[] | undefined;
      slotList: SlotDefinition[];
      agentList: AgentDefinition[];
    }) => {
      const sanitized = produceAssignments(
        input.entries,
        input.slotList,
        input.agentList,
      );
      if (sanitized.length > 0) {
        return sanitized;
      }
      const fallback = produceAssignments(
        defaultAssignments,
        input.slotList,
        input.agentList,
      );
      if (fallback.length > 0) {
        return fallback;
      }
      if (input.slotList.length > 0 && input.agentList.length > 0) {
        const generated: AssignmentRecord[] = [];
        for (let index = 0; index < input.slotList.length; index++) {
          const agent = input.agentList[index % input.agentList.length];
          if (!agent) break;
          generated.push({
            slot: input.slotList[index].id,
            agent: agent.id,
          });
        }
        return generated;
      }
      return [];
    })({
      entries: assignments,
      slotList: slotsList,
      agentList: agentsList,
    });

    const assignmentStore = cell<AssignmentRecord[]>([]);

    const schedule = lift((input: {
      stored: AssignmentRecord[];
      base: AssignmentRecord[];
    }) => {
      const stored = Array.isArray(input.stored) ? input.stored : [];
      if (stored.length > 0) {
        return stored.map((entry) => ({ ...entry }));
      }
      const base = Array.isArray(input.base) ? input.base : [];
      return base.map((entry) => ({ ...entry }));
    })({
      stored: assignmentStore,
      base: baseSchedule,
    });

    const coverage = lift((input: {
      slotList: SlotDefinition[];
      records: AssignmentRecord[];
      agentList: AgentDefinition[];
    }) => buildCoverageEntries(input.slotList, input.records, input.agentList))(
      {
        slotList: slotsList,
        records: schedule,
        agentList: agentsList,
      },
    );

    const gapCount = lift((entries: SlotCoverage[]) =>
      entries.filter((entry) => entry.hasGap).length
    )(coverage);

    const totalSlots = lift((entries: SlotDefinition[]) => entries.length)(
      slotsList,
    );
    const coveredSlots = lift((entries: SlotCoverage[]) =>
      entries.filter((entry) => !entry.hasGap).length
    )(coverage);

    const history = cell<string[]>([]);
    const latestChange = cell<LatestChange | null>(null);
    const sequence = cell(0);

    // UI form fields
    const slotField = cell<string>("");
    const agentField = cell<string>("");

    // Handlers for UI interactions
    const assignAgent = handler<
      unknown,
      {
        slotInput: Cell<string>;
        agentInput: Cell<string>;
        assignments: Cell<AssignmentRecord[]>;
        baseSchedule: Cell<AssignmentRecord[]>;
        slots: Cell<SlotDefinition[]>;
        agents: Cell<AgentDefinition[]>;
        history: Cell<string[]>;
        latestChange: Cell<LatestChange | null>;
        sequence: Cell<number>;
      }
    >(
      (_event, context) => {
        const slotValue = context.slotInput.get();
        const agentValue = context.agentInput.get();

        if (
          typeof slotValue !== "string" || slotValue.trim() === "" ||
          typeof agentValue !== "string" || agentValue.trim() === ""
        ) {
          return;
        }

        const slots = context.slots.get() ?? [];
        const agents = context.agents.get() ?? [];

        const slotId = resolveSlotId(slots, slotValue);
        const agentId = resolveAgentId(agents, agentValue);

        if (!slotId || !agentId) return;

        // Inline implementation of assignment logic
        const storedRecords = context.assignments.get();
        const baseRecords = context.baseSchedule.get();
        const current = Array.isArray(storedRecords) && storedRecords.length > 0
          ? [...storedRecords]
          : Array.isArray(baseRecords)
          ? [...baseRecords]
          : [];

        if (
          current.some((entry) =>
            entry.slot === slotId && entry.agent === agentId
          )
        ) {
          return;
        }

        current.push({ slot: slotId, agent: agentId });

        const slotOrder = new Map<string, number>();
        slots.forEach((slot, index) => slotOrder.set(slot.id, index));
        const agentOrder = new Map<string, number>();
        agents.forEach((agent, index) => agentOrder.set(agent.id, index));

        current.sort((left, right) => {
          const slotDiff = (slotOrder.get(left.slot) ?? 0) -
            (slotOrder.get(right.slot) ?? 0);
          if (slotDiff !== 0) return slotDiff;
          return (agentOrder.get(left.agent) ?? 0) -
            (agentOrder.get(right.agent) ?? 0);
        });

        const normalized = current.map((entry) => ({
          slot: entry.slot,
          agent: entry.agent,
        }));
        context.assignments.set(normalized);

        const coverage = buildCoverageEntries(slots, normalized, agents);
        const gapCount = coverage.reduce(
          (count, entry) => count + (entry.hasGap ? 1 : 0),
          0,
        );
        const coverageEntry = coverage.find((entry) => entry.slot === slotId);
        const slotLabel = coverageEntry?.label ?? slotId;
        const remaining = coverageEntry?.remaining ?? 0;

        const agentName = agents.find((entry) => entry.id === agentId)?.name ??
          agentId;
        const historyValue = context.history.get();
        const historyList = Array.isArray(historyValue) ? historyValue : [];
        const message = `Assigned ${agentName} to ${slotLabel}`;
        context.history.set([...historyList, message]);

        const sequenceValue = context.sequence.get();
        const nextSequence = typeof sequenceValue === "number"
          ? sequenceValue + 1
          : 1;
        context.sequence.set(nextSequence);

        context.latestChange.set({
          sequence: nextSequence,
          slot: slotId,
          label: slotLabel,
          action: "assign",
          agentId,
          agentName,
          gapCount,
          remaining,
        });

        context.slotInput.set("");
        context.agentInput.set("");
      },
    )({
      slotInput: slotField,
      agentInput: agentField,
      assignments: assignmentStore,
      baseSchedule,
      slots: slotsList,
      agents: agentsList,
      history,
      latestChange,
      sequence,
    });

    const unscheduleAgent = handler<
      unknown,
      {
        slotInput: Cell<string>;
        agentInput: Cell<string>;
        assignments: Cell<AssignmentRecord[]>;
        baseSchedule: Cell<AssignmentRecord[]>;
        slots: Cell<SlotDefinition[]>;
        agents: Cell<AgentDefinition[]>;
        history: Cell<string[]>;
        latestChange: Cell<LatestChange | null>;
        sequence: Cell<number>;
      }
    >(
      (_event, context) => {
        const slotValue = context.slotInput.get();
        const agentValue = context.agentInput.get();

        if (typeof slotValue !== "string" || slotValue.trim() === "") {
          return;
        }

        const slots = context.slots.get() ?? [];
        const agents = context.agents.get() ?? [];

        const slotId = resolveSlotId(slots, slotValue);
        if (!slotId) return;

        let agentId = agentValue && agentValue.trim() !== ""
          ? resolveAgentId(agents, agentValue)
          : null;

        // Inline implementation of unschedule logic
        const storedRecords = context.assignments.get();
        const baseRecords = context.baseSchedule.get();
        const current = Array.isArray(storedRecords) && storedRecords.length > 0
          ? [...storedRecords]
          : Array.isArray(baseRecords)
          ? [...baseRecords]
          : [];

        if (agentId) {
          const index = current.findIndex((entry) =>
            entry.slot === slotId && entry.agent === agentId
          );
          if (index === -1) return;
          current.splice(index, 1);
        } else {
          const index = current.findIndex((entry) => entry.slot === slotId);
          if (index === -1) return;
          const removed = current.splice(index, 1)[0];
          agentId = removed.agent;
        }

        const slotOrder = new Map<string, number>();
        slots.forEach((slot, index) => slotOrder.set(slot.id, index));
        const agentOrder = new Map<string, number>();
        agents.forEach((agent, index) => agentOrder.set(agent.id, index));

        current.sort((left, right) => {
          const slotDiff = (slotOrder.get(left.slot) ?? 0) -
            (slotOrder.get(right.slot) ?? 0);
          if (slotDiff !== 0) return slotDiff;
          return (agentOrder.get(left.agent) ?? 0) -
            (agentOrder.get(right.agent) ?? 0);
        });

        const normalized = current.map((entry) => ({
          slot: entry.slot,
          agent: entry.agent,
        }));
        context.assignments.set(normalized);

        const coverage = buildCoverageEntries(slots, normalized, agents);
        const gapCount = coverage.reduce(
          (count, entry) => count + (entry.hasGap ? 1 : 0),
          0,
        );
        const coverageEntry = coverage.find((entry) => entry.slot === slotId);
        const slotLabel = coverageEntry?.label ?? slotId;
        const remaining = coverageEntry?.remaining ?? 0;

        const agentName = agentId
          ? agents.find((entry) => entry.id === agentId)?.name ?? agentId
          : "";
        const historyValue = context.history.get();
        const historyList = Array.isArray(historyValue) ? historyValue : [];
        const message = `Removed ${agentName} from ${slotLabel}`;
        context.history.set([...historyList, message]);

        const sequenceValue = context.sequence.get();
        const nextSequence = typeof sequenceValue === "number"
          ? sequenceValue + 1
          : 1;
        context.sequence.set(nextSequence);

        if (agentId) {
          context.latestChange.set({
            sequence: nextSequence,
            slot: slotId,
            label: slotLabel,
            action: "unschedule",
            agentId,
            agentName,
            gapCount,
            remaining,
          });
        }

        context.slotInput.set("");
        context.agentInput.set("");
      },
    )({
      slotInput: slotField,
      agentInput: agentField,
      assignments: assignmentStore,
      baseSchedule,
      slots: slotsList,
      agents: agentsList,
      history,
      latestChange,
      sequence,
    });

    const name =
      str`Call Center Schedule: ${coveredSlots}/${totalSlots} slots covered`;

    const ui = (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "24px",
          maxWidth: "900px",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            marginBottom: "32px",
            padding: "20px",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            borderRadius: "12px",
            color: "white",
          }}
        >
          <h1 style={{ margin: "0 0 8px 0", fontSize: "28px" }}>
            Call Center Schedule
          </h1>
          <p style={{ margin: "0", fontSize: "16px", opacity: "0.95" }}>
            Manage agent assignments across time slots
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              padding: "16px",
              background: "#f0fdf4",
              border: "2px solid #86efac",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#166534",
                marginBottom: "4px",
              }}
            >
              Covered Slots
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: "#15803d" }}
            >
              {coveredSlots}/{totalSlots}
            </div>
          </div>
          <div
            style={{
              padding: "16px",
              background: lift((gaps: number) =>
                gaps > 0 ? "#fef2f2" : "#f0fdf4"
              )(gapCount),
              border: lift((gaps: number) =>
                gaps > 0 ? "2px solid #fca5a5" : "2px solid #86efac"
              )(gapCount),
              borderRadius: "8px",
            }}
          >
            <div
              style={lift((gaps: number) =>
                "font-size: 14px; margin-bottom: 4px; color: " +
                (gaps > 0 ? "#991b1b" : "#166534")
              )(gapCount)}
            >
              Coverage Gaps
            </div>
            <div
              style={lift((gaps: number) =>
                "font-size: 32px; font-weight: bold; color: " +
                (gaps > 0 ? "#dc2626" : "#15803d")
              )(gapCount)}
            >
              {gapCount}
            </div>
          </div>
          <div
            style={{
              padding: "16px",
              background: "#eff6ff",
              border: "2px solid #93c5fd",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#1e3a8a",
                marginBottom: "4px",
              }}
            >
              Total Agents
            </div>
            <div
              style={{ fontSize: "32px", fontWeight: "bold", color: "#1e40af" }}
            >
              {lift((list: AgentDefinition[]) => list.length)(agentsList)}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", marginBottom: "16px" }}>
            Schedule Controls
          </h2>
          <div
            style={{
              padding: "20px",
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
                marginBottom: "16px",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "14px",
                    fontWeight: "500",
                    marginBottom: "6px",
                  }}
                >
                  Time Slot ID
                </label>
                <ct-input
                  $value={slotField}
                  placeholder="e.g., 08:00-10:00"
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "14px",
                    fontWeight: "500",
                    marginBottom: "6px",
                  }}
                >
                  Agent ID or Name
                </label>
                <ct-input
                  $value={agentField}
                  placeholder="e.g., alex-rivera"
                  style={{ width: "100%" }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <ct-button
                onClick={assignAgent}
                style={{
                  flex: "1",
                  padding: "10px 20px",
                  background: "#10b981",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: "500",
                }}
              >
                Assign Agent
              </ct-button>
              <ct-button
                onClick={unscheduleAgent}
                style={{
                  flex: "1",
                  padding: "10px 20px",
                  background: "#ef4444",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontWeight: "500",
                }}
              >
                Remove Assignment
              </ct-button>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", marginBottom: "16px" }}>
            Coverage Overview
          </h2>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            {lift((coverageList: SlotCoverage[]) => {
              const elements: any[] = [];
              for (const slot of coverageList) {
                const borderColor = slot.hasGap ? "#fca5a5" : "#86efac";
                const bgColor = slot.hasGap ? "#fef2f2" : "#f0fdf4";
                const statusColor = slot.hasGap ? "#991b1b" : "#166534";

                elements.push(
                  <div
                    key={slot.slot}
                    style={{
                      padding: "16px",
                      background: bgColor,
                      border: "2px solid " + borderColor,
                      borderRadius: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "12px",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "18px",
                            fontWeight: "bold",
                            marginBottom: "4px",
                          }}
                        >
                          {slot.label}
                        </div>
                        <div
                          style={{
                            fontSize: "14px",
                            fontFamily: "monospace",
                            color: "#6b7280",
                          }}
                        >
                          {slot.slot}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div
                          style={{
                            fontSize: "14px",
                            color: statusColor,
                            fontWeight: "500",
                          }}
                        >
                          {slot.hasGap ? "NEEDS COVERAGE" : "FULLY COVERED"}
                        </div>
                        <div style={{ fontSize: "14px", color: "#6b7280" }}>
                          {slot.assignedCount}/{slot.required} assigned
                          {slot.remaining > 0
                            ? " (" + String(slot.remaining) + " needed)"
                            : ""}
                        </div>
                      </div>
                    </div>
                    {slot.assigned.length > 0
                      ? (
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          {slot.assigned.map((name) => (
                            <span
                              key={name}
                              style={{
                                padding: "4px 12px",
                                background: "#ffffff",
                                border: "1px solid #d1d5db",
                                borderRadius: "16px",
                                fontSize: "14px",
                              }}
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      )
                      : (
                        <div
                          style={{
                            fontSize: "14px",
                            color: "#9ca3af",
                            fontStyle: "italic",
                          }}
                        >
                          No agents assigned
                        </div>
                      )}
                  </div>,
                );
              }
              return elements;
            })(coverage)}
          </div>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", marginBottom: "16px" }}>
            Available Agents
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "12px",
            }}
          >
            {lift((agentList: AgentDefinition[]) => {
              const elements: any[] = [];
              for (const agent of agentList) {
                elements.push(
                  <div
                    key={agent.id}
                    style={{
                      padding: "12px",
                      background: "#ffffff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  >
                    <div style={{ fontWeight: "500", marginBottom: "4px" }}>
                      {agent.name}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        fontFamily: "monospace",
                        color: "#6b7280",
                      }}
                    >
                      {agent.id}
                    </div>
                  </div>,
                );
              }
              return elements;
            })(agentsList)}
          </div>
        </div>

        <div>
          <h2 style={{ fontSize: "20px", marginBottom: "16px" }}>
            Recent Activity
          </h2>
          <div
            style={{
              padding: "16px",
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              maxHeight: "300px",
              overflowY: "auto",
            }}
          >
            {lift((entries: string[]) => {
              if (!Array.isArray(entries) || entries.length === 0) {
                return (
                  <div style={{ color: "#9ca3af", fontStyle: "italic" }}>
                    No activity yet
                  </div>
                );
              }
              const reversed = entries.slice().reverse().slice(0, 10);
              const elements: any[] = [];
              for (let i = 0; i < reversed.length; i++) {
                const entry = reversed[i];
                const bgColor = i % 2 === 0 ? "#f9fafb" : "#ffffff";
                elements.push(
                  <div
                    key={i}
                    style={{
                      padding: "8px 12px",
                      background: bgColor,
                      borderRadius: "4px",
                      marginBottom: "4px",
                    }}
                  >
                    {entry}
                  </div>,
                );
              }
              return elements;
            })(history)}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      slots: slotsList,
      agents: agentsList,
      assignments: schedule,
      coverage,
      gapCount,
      history,
      latestChange,
      controls: {
        updateShift: updateSchedule({
          assignments: assignmentStore,
          baseSchedule,
          slots: slotsList,
          agents: agentsList,
          history,
          latestChange,
          sequence,
        }),
      },
    };
  },
);
