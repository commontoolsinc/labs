/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
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

type StepStatus = "pending" | "in_progress" | "blocked" | "complete";

interface IncidentStepSeed {
  id?: string;
  title?: string;
  owner?: string;
  status?: StepStatus;
  expectedMinutes?: number;
  elapsedMinutes?: number;
}

interface IncidentStep {
  id: string;
  title: string;
  owner: string;
  status: StepStatus;
  expectedMinutes: number;
  elapsedMinutes: number;
}

interface IncidentResponsePlaybookArgs {
  steps: Default<IncidentStepSeed[], []>;
}

interface IncidentStatusSummary {
  pending: number;
  inProgress: number;
  blocked: number;
  done: number;
}

interface StepBlueprint {
  id: string;
  title: string;
  owner: string;
  expectedMinutes: number;
}

const DEFAULT_BLUEPRINTS: readonly StepBlueprint[] = [
  {
    id: "triage",
    title: "Triage incident",
    owner: "incident-commander",
    expectedMinutes: 15,
  },
  {
    id: "contain",
    title: "Contain impact",
    owner: "operations",
    expectedMinutes: 30,
  },
  {
    id: "recover",
    title: "Recover services",
    owner: "platform",
    expectedMinutes: 45,
  },
];

const STALL_MULTIPLIER = 1.5;
const MIN_BLOCKED_MINUTES = 10;
const MAX_EXPECTED_MINUTES = 240;
const MAX_ELAPSED_MINUTES = 1440;

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeTitle = (
  value: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (fallback.length > 0) {
    return fallback;
  }
  return `Incident step ${index + 1}`;
};

const sanitizeOwner = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeStatus = (value: unknown): StepStatus => {
  if (value === "in_progress" || value === "blocked" || value === "complete") {
    return value;
  }
  return "pending";
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const sanitizeExpectedMinutes = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return clampNumber(rounded, 5, MAX_EXPECTED_MINUTES);
};

const sanitizeElapsedMinutes = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return clampNumber(rounded, 0, MAX_ELAPSED_MINUTES);
};

const sanitizeMinutesDelta = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 0;
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let id = `${candidate}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${candidate}-${index}`;
  }
  used.add(id);
  return id;
};

const sanitizeStep = (
  seed: IncidentStepSeed | undefined,
  index: number,
  blueprint: StepBlueprint,
  used: Set<string>,
): IncidentStep => {
  const baseId = sanitizeIdentifier(seed?.id, blueprint.id);
  const id = ensureUniqueId(baseId, used);
  const title = sanitizeTitle(seed?.title, blueprint.title, index);
  const owner = sanitizeOwner(seed?.owner, blueprint.owner);
  const expected = sanitizeExpectedMinutes(
    seed?.expectedMinutes,
    blueprint.expectedMinutes,
  );
  const status = sanitizeStatus(seed?.status);
  const baseElapsed = status === "pending" ? 0 : blueprint.expectedMinutes;
  const elapsed = sanitizeElapsedMinutes(seed?.elapsedMinutes, baseElapsed);
  return {
    id,
    title,
    owner,
    status,
    expectedMinutes: expected,
    elapsedMinutes: status === "pending" ? 0 : elapsed,
  };
};

const sanitizeState = (
  entries: readonly IncidentStepSeed[] | undefined,
): IncidentStep[] => {
  const seeds = Array.isArray(entries) ? entries : [];
  const count = Math.max(seeds.length, DEFAULT_BLUEPRINTS.length);
  const used = new Set<string>();
  const steps: IncidentStep[] = [];
  for (let index = 0; index < count; index += 1) {
    const blueprint = DEFAULT_BLUEPRINTS[index] ?? {
      id: `step-${index + 1}`,
      title: "Follow-up",
      owner: "unassigned",
      expectedMinutes: 20,
    };
    const step = sanitizeStep(seeds[index], index, blueprint, used);
    steps.push(step);
  }
  return steps;
};

const computeSummary = (
  steps: readonly IncidentStep[],
): IncidentStatusSummary => {
  const summary: IncidentStatusSummary = {
    pending: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
  };
  for (const step of steps) {
    switch (step.status) {
      case "in_progress":
        summary.inProgress += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "complete":
        summary.done += 1;
        break;
      default:
        summary.pending += 1;
        break;
    }
  }
  return summary;
};

const findStalledSteps = (steps: readonly IncidentStep[]): string[] => {
  const stalled: string[] = [];
  for (const step of steps) {
    if (step.status === "blocked") {
      if (step.elapsedMinutes >= MIN_BLOCKED_MINUTES) {
        stalled.push(step.id);
      }
      continue;
    }
    if (step.status !== "in_progress") continue;
    const limit = Math.max(
      Math.round(step.expectedMinutes * STALL_MULTIPLIER),
      step.expectedMinutes + 5,
    );
    if (step.elapsedMinutes >= limit) {
      stalled.push(step.id);
    }
  }
  return stalled;
};

const toHistory = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      result.push(entry);
    }
  }
  return result;
};

const beginIncidentStep = handler(
  (
    event: { stepId?: string } | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
    },
  ) => {
    const current = sanitizeState(context.steps.get());
    const requested = sanitizeIdentifier(
      event?.stepId,
      context.active.get() ?? current[0]?.id ?? "",
    );
    if (requested.length === 0) return;
    let found = false;
    const next: IncidentStep[] = [];
    for (const step of current) {
      if (step.id !== requested) {
        next.push(step);
        continue;
      }
      found = true;
      next.push({
        ...step,
        status: "in_progress",
        elapsedMinutes: 0,
      });
    }
    if (!found) return;
    context.steps.set(next as IncidentStepSeed[]);
    context.active.set(requested);
    const history = toHistory(context.history.get());
    const entry = `Started ${requested}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const noteElapsedTime = handler(
  (
    event: { stepId?: string; minutes?: number } | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
      clock: Cell<number>;
    },
  ) => {
    const minutes = sanitizeMinutesDelta(event?.minutes);
    if (minutes === 0) return;
    const baseline = sanitizeState(context.steps.get());
    const fallback = context.active.get() ?? baseline[0]?.id ?? "";
    const targetId = sanitizeIdentifier(event?.stepId, fallback);
    if (targetId.length === 0) return;
    let applied = false;
    const next: IncidentStep[] = [];
    for (const step of baseline) {
      if (step.id !== targetId) {
        next.push(step);
        continue;
      }
      applied = true;
      const elapsed = step.elapsedMinutes + minutes;
      next.push({
        ...step,
        elapsedMinutes: clampNumber(elapsed, 0, MAX_ELAPSED_MINUTES),
      });
    }
    if (!applied) return;
    context.steps.set(next as IncidentStepSeed[]);
    const clockRaw = context.clock.get();
    const clock = typeof clockRaw === "number" && Number.isFinite(clockRaw)
      ? clockRaw
      : 0;
    context.clock.set(clock + minutes);
    const history = toHistory(context.history.get());
    const entry = `Logged ${minutes}m on ${targetId}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const updateStepStatus = handler(
  (
    event:
      | { stepId?: string; status?: StepStatus; minutes?: number }
      | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
    },
  ) => {
    const baseline = sanitizeState(context.steps.get());
    const fallback = context.active.get() ?? baseline[0]?.id ?? "";
    const targetId = sanitizeIdentifier(event?.stepId, fallback);
    if (targetId.length === 0) return;
    const status = sanitizeStatus(event?.status);
    const delta = sanitizeMinutesDelta(event?.minutes);
    let found = false;
    const next: IncidentStep[] = [];
    for (const step of baseline) {
      if (step.id !== targetId) {
        next.push(step);
        continue;
      }
      found = true;
      const updatedElapsed = step.elapsedMinutes + delta;
      next.push({
        ...step,
        status,
        elapsedMinutes: status === "pending" ? 0 : updatedElapsed,
      });
    }
    if (!found) return;
    context.steps.set(next as IncidentStepSeed[]);
    if (status === "complete" && context.active.get() === targetId) {
      context.active.set(null);
    } else if (status === "in_progress") {
      context.active.set(targetId);
    }
    const history = toHistory(context.history.get());
    const entry = `Marked ${targetId} as ${status}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const resetPlaybook = handler(
  (
    _event: unknown,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
      clock: Cell<number>;
    },
  ) => {
    const baseline = sanitizeState(context.steps.get());
    const resetSteps: IncidentStep[] = [];
    for (const step of baseline) {
      resetSteps.push({
        ...step,
        status: "pending",
        elapsedMinutes: 0,
      });
    }
    context.steps.set(resetSteps as IncidentStepSeed[]);
    context.history.set([]);
    context.active.set(null);
    context.clock.set(0);
  },
);

export const incidentResponsePlaybookUx = recipe<IncidentResponsePlaybookArgs>(
  "Incident Response Playbook (UX)",
  ({ steps }) => {
    const history = cell<string[]>([]);
    const activeStep = cell<string | null>(null);
    const clock = cell(0);

    const stepsView = lift(sanitizeState)(steps);

    const summary = lift((input: IncidentStep[]) => computeSummary(input))(
      stepsView,
    );

    const pendingCount = lift((value: IncidentStatusSummary) => value.pending)(
      summary,
    );
    const inProgressCount = lift(
      (value: IncidentStatusSummary) => value.inProgress,
    )(summary);
    const blockedCount = lift((value: IncidentStatusSummary) => value.blocked)(
      summary,
    );
    const doneCount = lift((value: IncidentStatusSummary) => value.done)(
      summary,
    );

    const statusLabel =
      str`Pending ${pendingCount} | Active ${inProgressCount} | Blocked ${blockedCount} | Done ${doneCount}`;

    const stalledSteps = lift((input: IncidentStep[]) =>
      findStalledSteps(input)
    )(
      stepsView,
    );

    const stalledCount = lift((value: string[]) => value.length)(stalledSteps);
    const needsEscalation = lift((count: number) => count > 0)(stalledCount);
    const escalationState = lift((flag: boolean) =>
      flag ? "required" : "clear"
    )(needsEscalation);
    const escalationLabel =
      str`Escalation ${escalationState} (${stalledCount})`;

    const timeline = lift((entries: string[] | undefined) =>
      toHistory(entries)
    )(
      history,
    );

    const latestLogEntry = derive(timeline, (entries) => {
      if (entries.length === 0) {
        return "ready";
      }
      return entries[entries.length - 1];
    });

    const activeStepId = lift((value: string | null | undefined) =>
      typeof value === "string" && value.length > 0 ? value : ""
    )(activeStep);

    const activeStepTitle = derive(stepsView, (list) => {
      const id = activeStep.get();
      if (!id) {
        return "idle";
      }
      const target = list.find((step) => step.id === id);
      return target ? target.title : "idle";
    });

    const clockMinutes = lift((value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0
    )(clock);

    // UI form fields
    const stepIdField = cell<string>("");
    const minutesField = cell<string>("");
    const statusField = cell<string>("complete");

    // UI handlers
    const uiStartStep = handler<
      unknown,
      {
        stepIdInput: Cell<string>;
        steps: Cell<IncidentStepSeed[]>;
        history: Cell<string[]>;
        active: Cell<string | null>;
      }
    >((_event, { stepIdInput, steps, history, active }) => {
      const stepIdStr = stepIdInput.get();
      if (typeof stepIdStr !== "string" || stepIdStr.trim() === "") return;
      const stepId = stepIdStr.trim();

      const current = sanitizeState(steps.get());
      const requested = sanitizeIdentifier(stepId, current[0]?.id ?? "");
      if (requested.length === 0) return;
      let found = false;
      const next: IncidentStep[] = [];
      for (const step of current) {
        if (step.id !== requested) {
          next.push(step);
          continue;
        }
        found = true;
        next.push({
          ...step,
          status: "in_progress",
          elapsedMinutes: 0,
        });
      }
      if (!found) return;
      steps.set(next as IncidentStepSeed[]);
      active.set(requested);
      const historyEntries = toHistory(history.get());
      const entry = `Started ${requested}`;
      const updates = [...historyEntries, entry];
      history.set(updates);
      stepIdInput.set("");
    })({ stepIdInput: stepIdField, steps, history, active: activeStep });

    const uiLogTime = handler<
      unknown,
      {
        stepIdInput: Cell<string>;
        minutesInput: Cell<string>;
        steps: Cell<IncidentStepSeed[]>;
        history: Cell<string[]>;
        active: Cell<string | null>;
        clock: Cell<number>;
      }
    >(
      (
        _event,
        { stepIdInput, minutesInput, steps, history, active, clock },
      ) => {
        const minutesStr = minutesInput.get();
        if (typeof minutesStr !== "string" || minutesStr.trim() === "") return;
        const minutes = sanitizeMinutesDelta(Number(minutesStr));
        if (minutes === 0) return;

        const baseline = sanitizeState(steps.get());
        const stepIdStr = stepIdInput.get();
        const fallback = active.get() ?? baseline[0]?.id ?? "";
        const targetId = sanitizeIdentifier(
          typeof stepIdStr === "string" && stepIdStr.trim() !== ""
            ? stepIdStr.trim()
            : fallback,
          fallback,
        );
        if (targetId.length === 0) return;
        let applied = false;
        const next: IncidentStep[] = [];
        for (const step of baseline) {
          if (step.id !== targetId) {
            next.push(step);
            continue;
          }
          applied = true;
          const elapsed = step.elapsedMinutes + minutes;
          next.push({
            ...step,
            elapsedMinutes: clampNumber(elapsed, 0, MAX_ELAPSED_MINUTES),
          });
        }
        if (!applied) return;
        steps.set(next as IncidentStepSeed[]);
        const clockRaw = clock.get();
        const clockVal = typeof clockRaw === "number" &&
            Number.isFinite(clockRaw)
          ? clockRaw
          : 0;
        clock.set(clockVal + minutes);
        const historyEntries = toHistory(history.get());
        const entry = `Logged ${minutes}m on ${targetId}`;
        const updates = [...historyEntries, entry];
        history.set(updates);
        stepIdInput.set("");
        minutesInput.set("");
      },
    )({
      stepIdInput: stepIdField,
      minutesInput: minutesField,
      steps,
      history,
      active: activeStep,
      clock,
    });

    const uiUpdateStatus = handler<
      unknown,
      {
        stepIdInput: Cell<string>;
        statusInput: Cell<string>;
        minutesInput: Cell<string>;
        steps: Cell<IncidentStepSeed[]>;
        history: Cell<string[]>;
        active: Cell<string | null>;
      }
    >(
      (
        _event,
        { stepIdInput, statusInput, minutesInput, steps, history, active },
      ) => {
        const baseline = sanitizeState(steps.get());
        const stepIdStr = stepIdInput.get();
        const fallback = active.get() ?? baseline[0]?.id ?? "";
        const targetId = sanitizeIdentifier(
          typeof stepIdStr === "string" && stepIdStr.trim() !== ""
            ? stepIdStr.trim()
            : fallback,
          fallback,
        );
        if (targetId.length === 0) return;

        const statusStr = statusInput.get();
        const status = sanitizeStatus(
          typeof statusStr === "string" ? statusStr : undefined,
        );

        const minutesStr = minutesInput.get();
        const delta = typeof minutesStr === "string" && minutesStr.trim() !== ""
          ? sanitizeMinutesDelta(Number(minutesStr))
          : 0;

        let found = false;
        const next: IncidentStep[] = [];
        for (const step of baseline) {
          if (step.id !== targetId) {
            next.push(step);
            continue;
          }
          found = true;
          const updatedElapsed = step.elapsedMinutes + delta;
          next.push({
            ...step,
            status,
            elapsedMinutes: status === "pending" ? 0 : updatedElapsed,
          });
        }
        if (!found) return;
        steps.set(next as IncidentStepSeed[]);
        if (status === "complete" && active.get() === targetId) {
          active.set(null);
        } else if (status === "in_progress") {
          active.set(targetId);
        }
        const historyEntries = toHistory(history.get());
        const entry = `Marked ${targetId} as ${status}`;
        const updates = [...historyEntries, entry];
        history.set(updates);
        stepIdInput.set("");
        minutesInput.set("");
      },
    )({
      stepIdInput: stepIdField,
      statusInput: statusField,
      minutesInput: minutesField,
      steps,
      history,
      active: activeStep,
    });

    const uiReset = handler<
      unknown,
      {
        steps: Cell<IncidentStepSeed[]>;
        history: Cell<string[]>;
        active: Cell<string | null>;
        clock: Cell<number>;
      }
    >((_event, { steps, history, active, clock }) => {
      const baseline = sanitizeState(steps.get());
      const resetSteps: IncidentStep[] = [];
      for (const step of baseline) {
        resetSteps.push({
          ...step,
          status: "pending",
          elapsedMinutes: 0,
        });
      }
      steps.set(resetSteps as IncidentStepSeed[]);
      history.set([]);
      active.set(null);
      clock.set(0);
    })({ steps, history, active: activeStep, clock });

    const name = str`Incident Response (${escalationState})`;

    const stepsUi = lift((stepsList: IncidentStep[]) => {
      const elements = [];
      for (const step of stepsList) {
        const statusColor = step.status === "complete"
          ? "#10b981"
          : step.status === "in_progress"
          ? "#3b82f6"
          : step.status === "blocked"
          ? "#ef4444"
          : "#9ca3af";

        const progressPct = step.expectedMinutes > 0
          ? Math.min((step.elapsedMinutes / step.expectedMinutes) * 100, 100)
          : 0;

        const isStalled = step.status === "in_progress" &&
          step.elapsedMinutes >=
            Math.max(
              Math.round(step.expectedMinutes * STALL_MULTIPLIER),
              step.expectedMinutes + 5,
            );

        const cardBg = isStalled ? "#fef2f2" : "#ffffff";
        const cardBorder = isStalled
          ? "2px solid #ef4444"
          : "1px solid #e5e7eb";

        elements.push(
          h(
            "div",
            {
              style: "background: " + cardBg + "; border: " + cardBorder +
                "; border-radius: 8px; padding: 16px; margin-bottom: 12px;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;",
              },
              h(
                "div",
                { style: "font-weight: 600; font-size: 16px;" },
                step.title,
              ),
              h(
                "span",
                {
                  style: "background: " + statusColor +
                    "; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; text-transform: uppercase; font-weight: 600;",
                },
                step.status.replace("_", " "),
              ),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; font-size: 14px; color: #6b7280;",
              },
              h("div", {}, "ID: ", h("code", {}, step.id)),
              h("div", {}, "Owner: ", step.owner),
              h(
                "div",
                {},
                "Time: ",
                String(step.elapsedMinutes),
                "m / ",
                String(step.expectedMinutes),
                "m",
              ),
            ),
            h(
              "div",
              {
                style:
                  "width: 100%; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;",
              },
              h("div", {
                style: "width: " + String(progressPct) +
                  "%; height: 100%; background: " + statusColor +
                  "; transition: width 0.3s;",
              }),
            ),
          ),
        );
      }
      return h("div", {}, ...elements);
    })(stepsView);

    const timelineUi = lift((entries: string[]) => {
      if (entries.length === 0) {
        return h(
          "div",
          { style: "padding: 16px; color: #9ca3af; text-align: center;" },
          "No activity yet",
        );
      }
      const reversed = entries.slice().reverse();
      const elements = [];
      for (let i = 0; i < Math.min(reversed.length, 8); i++) {
        elements.push(
          h(
            "div",
            {
              style:
                "padding: 8px 12px; border-left: 3px solid #3b82f6; background: #f9fafb; margin-bottom: 6px; font-size: 14px;",
            },
            reversed[i],
          ),
        );
      }
      return h("div", {}, ...elements);
    })(timeline);

    const escalationBadgeStyle = lift((needs: boolean) => {
      if (needs) {
        return "background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; text-align: center; font-weight: 600; font-size: 18px;";
      }
      return "background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; text-align: center; font-weight: 600; font-size: 18px;";
    })(needsEscalation);

    const ui = (
      <div
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          padding: "20px",
          fontFamily: "system-ui, sans-serif",
          background: "#f9fafb",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
            color: "white",
            padding: "24px",
            borderRadius: "12px",
            marginBottom: "24px",
          }}
        >
          <h1 style={{ margin: "0 0 8px 0", fontSize: "28px" }}>
            🚨 Incident Response Playbook
          </h1>
          <div style={{ fontSize: "16px", opacity: "0.9" }}>{statusLabel}</div>
        </div>

        <div style={escalationBadgeStyle}>
          {escalationLabel}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              background: "white",
              padding: "20px",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#6b7280",
                marginBottom: "4px",
              }}
            >
              Active Step
            </div>
            <div style={{ fontSize: "20px", fontWeight: "600" }}>
              {activeStepTitle}
            </div>
          </div>

          <div
            style={{
              background: "white",
              padding: "20px",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                color: "#6b7280",
                marginBottom: "4px",
              }}
            >
              Total Elapsed
            </div>
            <div style={{ fontSize: "20px", fontWeight: "600" }}>
              {clockMinutes} minutes
            </div>
          </div>
        </div>

        <h2 style={{ fontSize: "20px", marginBottom: "12px" }}>
          Response Steps
        </h2>
        {stepsUi}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "20px",
            marginTop: "32px",
          }}
        >
          <div
            style={{
              background: "white",
              padding: "20px",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
            }}
          >
            <h3
              style={{
                fontSize: "18px",
                marginBottom: "16px",
                marginTop: "0",
              }}
            >
              Step Controls
            </h3>

            <div style={{ marginBottom: "16px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "14px",
                  fontWeight: "500",
                  marginBottom: "4px",
                }}
              >
                Step ID
              </label>
              <ct-input
                $value={stepIdField}
                placeholder="e.g., triage"
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                }}
              />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "14px",
                  fontWeight: "500",
                  marginBottom: "4px",
                }}
              >
                Minutes
              </label>
              <ct-input
                $value={minutesField}
                placeholder="e.g., 15"
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: "8px",
                marginBottom: "16px",
              }}
            >
              <ct-button
                onClick={uiStartStep}
                style={{
                  background: "#3b82f6",
                  color: "white",
                  padding: "10px",
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: "500",
                }}
              >
                Start Step
              </ct-button>

              <ct-button
                onClick={uiLogTime}
                style={{
                  background: "#8b5cf6",
                  color: "white",
                  padding: "10px",
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: "500",
                }}
              >
                Log Time
              </ct-button>
            </div>

            <div style={{ marginBottom: "8px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "14px",
                  fontWeight: "500",
                  marginBottom: "4px",
                }}
              >
                Status
              </label>
              <select
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                }}
                onChange={(e) => statusField.set(e.target.value)}
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="complete" selected>
                  Complete
                </option>
              </select>
            </div>

            <ct-button
              onClick={uiUpdateStatus}
              style={{
                background: "#10b981",
                color: "white",
                padding: "10px",
                borderRadius: "4px",
                border: "none",
                cursor: "pointer",
                fontWeight: "500",
                width: "100%",
                marginBottom: "16px",
              }}
            >
              Update Status
            </ct-button>

            <ct-button
              onClick={uiReset}
              style={{
                background: "#ef4444",
                color: "white",
                padding: "10px",
                borderRadius: "4px",
                border: "none",
                cursor: "pointer",
                fontWeight: "500",
                width: "100%",
              }}
            >
              Reset Playbook
            </ct-button>
          </div>

          <div
            style={{
              background: "white",
              padding: "20px",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
            }}
          >
            <h3
              style={{
                fontSize: "18px",
                marginBottom: "12px",
                marginTop: "0",
              }}
            >
              Activity Timeline
            </h3>
            {timelineUi}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      steps: stepsView,
      summary,
      statusLabel,
      stalledSteps,
      stalledCount,
      needsEscalation,
      escalationLabel,
      timeline,
      latestLogEntry,
      activeStepId,
      activeStepTitle,
      clockMinutes,
      handlers: {
        start: beginIncidentStep({
          steps,
          history,
          active: activeStep,
        }),
        logElapsed: noteElapsedTime({
          steps,
          history,
          active: activeStep,
          clock,
        }),
        updateStatus: updateStepStatus({
          steps,
          history,
          active: activeStep,
        }),
        reset: resetPlaybook({
          steps,
          history,
          active: activeStep,
          clock,
        }),
      },
    };
  },
);

export type {
  IncidentResponsePlaybookArgs,
  IncidentStatusSummary,
  IncidentStep,
  IncidentStepSeed,
};
