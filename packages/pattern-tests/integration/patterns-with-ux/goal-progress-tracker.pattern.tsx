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

interface MilestoneInput {
  label?: string;
  weight?: number;
  completed?: boolean;
}

type MilestoneInputRecord = Record<string, MilestoneInput>;

interface MilestoneState {
  label: string;
  weight: number;
  completed: boolean;
}

type MilestoneRecord = Record<string, MilestoneState>;

interface TotalsSnapshot {
  total: number;
  completed: number;
  remaining: number;
  percent: number;
}

interface CompletionEvent {
  id?: string;
  completed?: boolean;
}

interface ReweightEvent {
  id?: string;
  weight?: number;
  delta?: number;
}

const defaultMilestones: MilestoneInputRecord = {
  kickoff: { label: "Kickoff review", weight: 30, completed: true },
  design: { label: "Design lock", weight: 40, completed: false },
  launch: { label: "Launch readiness", weight: 30, completed: false },
};

interface GoalProgressArgs {
  milestones: Default<MilestoneInputRecord, typeof defaultMilestones>;
}

const roundToTwoDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const roundToOneDecimal = (value: number): number => {
  return Math.round(value * 10) / 10;
};

const sanitizeWeight = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundToTwoDecimals(Math.max(0, fallback));
  }
  return roundToTwoDecimals(Math.max(0, value));
};

const sanitizeKey = (raw: string, fallback: string): string => {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const fallbackLabelFromKey = (key: string): string => {
  const parts = key.split(/[-_ ]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "Milestone";
  return parts
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeMilestone = (
  value: MilestoneInput | undefined,
  fallbackLabel: string,
): MilestoneState => {
  const label =
    typeof value?.label === "string" && value.label.trim().length > 0
      ? value.label.trim()
      : fallbackLabel;
  const weight = sanitizeWeight(value?.weight, 1);
  const completed = typeof value?.completed === "boolean"
    ? value.completed
    : false;
  return { label, weight, completed };
};

const sanitizeMilestoneMap = (value: unknown): MilestoneRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const rawEntries = Object.entries(value as Record<string, unknown>);
  rawEntries.sort((left, right) => left[0].localeCompare(right[0]));
  const used = new Set<string>();
  const result: MilestoneRecord = {};
  for (let index = 0; index < rawEntries.length; index += 1) {
    const [rawKey, rawValue] = rawEntries[index];
    const fallbackKey = `milestone-${index + 1}`;
    let key = sanitizeKey(rawKey, fallbackKey);
    if (used.has(key)) {
      let suffix = 2;
      while (used.has(`${key}-${suffix}`)) {
        suffix += 1;
      }
      key = `${key}-${suffix}`;
    }
    used.add(key);
    const label = fallbackLabelFromKey(key);
    const entry = sanitizeMilestone(
      rawValue as MilestoneInput | undefined,
      label,
    );
    result[key] = entry;
  }
  return result;
};

const normalizeEventId = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const updateMilestoneCompletion = handler(
  (
    event: CompletionEvent | undefined,
    context: { milestones: Cell<MilestoneInputRecord> },
  ) => {
    const id = normalizeEventId(event?.id);
    if (!id) return;
    const current = sanitizeMilestoneMap(context.milestones.get());
    const target = current[id];
    if (!target) return;
    const nextCompleted = typeof event?.completed === "boolean"
      ? event.completed
      : !target.completed;
    const updated: MilestoneInputRecord = { ...current };
    updated[id] = { ...target, completed: nextCompleted };
    context.milestones.set(updated);
  },
);

const adjustMilestoneWeight = handler(
  (
    event: ReweightEvent | undefined,
    context: { milestones: Cell<MilestoneInputRecord> },
  ) => {
    const id = normalizeEventId(event?.id);
    if (!id) return;
    const current = sanitizeMilestoneMap(context.milestones.get());
    const target = current[id];
    if (!target) return;
    const hasWeight = typeof event?.weight === "number" &&
      Number.isFinite(event.weight);
    const hasDelta = typeof event?.delta === "number" &&
      Number.isFinite(event.delta);
    if (!hasWeight && !hasDelta) return;
    const nextWeight = hasWeight
      ? sanitizeWeight(event?.weight, target.weight)
      : sanitizeWeight(target.weight + (event?.delta ?? 0), target.weight);
    const updated: MilestoneInputRecord = { ...current };
    updated[id] = { ...target, weight: nextWeight };
    context.milestones.set(updated);
  },
);

export const goalProgressTrackerUx = recipe<GoalProgressArgs>(
  "Goal Progress Tracker (UX)",
  ({ milestones }) => {
    const sanitized = lift(sanitizeMilestoneMap)(milestones);

    const totals = lift((records: MilestoneRecord): TotalsSnapshot => {
      const entries = Object.values(records);
      let total = 0;
      let completed = 0;
      for (const entry of entries) {
        total += entry.weight;
        if (entry.completed) {
          completed += entry.weight;
        }
      }
      const roundedTotal = roundToTwoDecimals(total);
      const roundedCompleted = roundToTwoDecimals(completed);
      const remaining = roundToTwoDecimals(roundedTotal - roundedCompleted);
      const percent = roundedTotal === 0
        ? 0
        : roundToOneDecimal((roundedCompleted / roundedTotal) * 100);
      return {
        total: roundedTotal,
        completed: roundedCompleted,
        remaining,
        percent,
      };
    })(sanitized);

    const totalWeight = lift((snapshot: TotalsSnapshot) => snapshot.total)(
      totals,
    );
    const completedWeight = lift((snapshot: TotalsSnapshot) =>
      snapshot.completed
    )(
      totals,
    );
    const remainingWeight = lift((snapshot: TotalsSnapshot) =>
      snapshot.remaining
    )(
      totals,
    );
    const completionPercent = lift((snapshot: TotalsSnapshot) =>
      snapshot.percent
    )(
      totals,
    );

    const milestoneList = lift((inputs: {
      records: MilestoneRecord;
      total: number;
    }) => {
      const entries = Object.entries(inputs.records).map(([id, data]) => {
        const percentOfTotal = inputs.total === 0
          ? 0
          : roundToOneDecimal((data.weight / inputs.total) * 100);
        const completedShare = data.completed ? percentOfTotal : 0;
        return {
          id,
          label: data.label,
          weight: data.weight,
          completed: data.completed,
          percentOfTotal,
          completedShare,
        };
      });
      entries.sort((left, right) => left.label.localeCompare(right.label));
      return entries;
    })({
      records: sanitized,
      total: totalWeight,
    });

    const formattedPercent = lift((value: number) => value.toFixed(1))(
      completionPercent,
    );

    const summary =
      str`${formattedPercent}% complete (${completedWeight}/${totalWeight})`;

    // UI handlers
    const milestoneIdField = cell<string>("");
    const labelField = cell<string>("");
    const weightField = cell<string>("");

    const addMilestoneHandler = handler(
      (_event: unknown, context: {
        milestones: Cell<MilestoneInputRecord>;
        idField: Cell<string>;
        labelField: Cell<string>;
        weightField: Cell<string>;
      }) => {
        const id = normalizeEventId(context.idField.get());
        if (!id) return;
        const labelStr = context.labelField.get();
        const label = typeof labelStr === "string" && labelStr.trim() !== ""
          ? labelStr.trim()
          : fallbackLabelFromKey(id);
        const weightStr = context.weightField.get();
        const weight = typeof weightStr === "string" && weightStr.trim() !== ""
          ? Number(weightStr)
          : 1;
        if (!Number.isFinite(weight)) return;

        const current = sanitizeMilestoneMap(context.milestones.get());
        if (current[id]) return; // Don't overwrite existing

        const updated: MilestoneInputRecord = { ...current };
        updated[id] = {
          label,
          weight: sanitizeWeight(weight, 1),
          completed: false,
        };
        context.milestones.set(updated);
        context.idField.set("");
        context.labelField.set("");
        context.weightField.set("");
      },
    );

    const toggleMilestoneHandler = handler(
      (_event: unknown, context: {
        milestones: Cell<MilestoneInputRecord>;
        idField: Cell<string>;
      }) => {
        const id = normalizeEventId(context.idField.get());
        if (!id) return;
        const current = sanitizeMilestoneMap(context.milestones.get());
        const target = current[id];
        if (!target) return;
        const updated: MilestoneInputRecord = { ...current };
        updated[id] = { ...target, completed: !target.completed };
        context.milestones.set(updated);
        context.idField.set("");
      },
    );

    const adjustWeightHandler = handler(
      (_event: unknown, context: {
        milestones: Cell<MilestoneInputRecord>;
        idField: Cell<string>;
        weightField: Cell<string>;
      }) => {
        const id = normalizeEventId(context.idField.get());
        if (!id) return;
        const weightStr = context.weightField.get();
        if (typeof weightStr !== "string" || weightStr.trim() === "") return;
        const weight = Number(weightStr);
        if (!Number.isFinite(weight)) return;

        const current = sanitizeMilestoneMap(context.milestones.get());
        const target = current[id];
        if (!target) return;
        const nextWeight = sanitizeWeight(weight, target.weight);
        const updated: MilestoneInputRecord = { ...current };
        updated[id] = { ...target, weight: nextWeight };
        context.milestones.set(updated);
        context.idField.set("");
        context.weightField.set("");
      },
    );

    const addMilestone = addMilestoneHandler({
      milestones,
      idField: milestoneIdField,
      labelField,
      weightField,
    });

    const toggleMilestone = toggleMilestoneHandler({
      milestones,
      idField: milestoneIdField,
    });

    const adjustWeight = adjustWeightHandler({
      milestones,
      idField: milestoneIdField,
      weightField,
    });

    const name = str`Goal Progress: ${formattedPercent}%`;

    const milestonesDisplay = lift((inputs: {
      list: typeof milestoneList extends Cell<infer T> ? T : never;
      percent: number;
      completed: number;
      total: number;
      remaining: number;
    }) => {
      const progressBarWidth = String(inputs.percent) + "%";
      const progressColor = inputs.percent < 33
        ? "#ef4444"
        : inputs.percent < 66
        ? "#f59e0b"
        : "#10b981";

      const milestoneElements = [];
      for (const item of inputs.list) {
        const statusColor = item.completed ? "#10b981" : "#94a3b8";
        const statusBg = item.completed
          ? "rgba(16, 185, 129, 0.1)"
          : "rgba(148, 163, 184, 0.1)";
        const checkmark = item.completed ? "✓" : "○";

        const milestoneCard = h(
          "div",
          {
            style: "background: white; border: 2px solid " +
              statusColor +
              "; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px;",
          },
          h(
            "div",
            {
              style:
                "display: flex; justify-content: space-between; align-items: center;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600;",
              },
              h(
                "span",
                {
                  style:
                    "display: inline-block; width: 24px; height: 24px; border-radius: 50%; background: " +
                    statusBg +
                    "; color: " +
                    statusColor +
                    "; text-align: center; line-height: 24px; font-size: 14px;",
                },
                checkmark,
              ),
              h("span", {}, item.label),
            ),
            h(
              "span",
              {
                style:
                  "font-size: 14px; color: #64748b; font-family: monospace;",
              },
              item.id,
            ),
          ),
          h(
            "div",
            { style: "display: flex; gap: 16px; font-size: 14px;" },
            h(
              "div",
              {},
              h("strong", {}, "Weight: "),
              h(
                "span",
                { style: "font-family: monospace;" },
                String(
                  item.weight,
                ),
              ),
            ),
            h(
              "div",
              {},
              h("strong", {}, "Share: "),
              h(
                "span",
                { style: "font-family: monospace;" },
                String(
                  item.percentOfTotal,
                ) + "%",
              ),
            ),
          ),
        );
        milestoneElements.push(milestoneCard);
      }

      return h(
        "div",
        {
          style:
            "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;",
        },
        h(
          "div",
          {
            style:
              "background: white; border-radius: 16px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.1);",
          },
          h(
            "h1",
            {
              style:
                "margin: 0 0 8px 0; font-size: 28px; color: #1e293b; font-weight: 700;",
            },
            "Goal Progress Tracker",
          ),
          h(
            "p",
            { style: "margin: 0 0 24px 0; color: #64748b; font-size: 14px;" },
            "Track milestone completion with weighted progress",
          ),
          h(
            "div",
            {
              style: "background: linear-gradient(135deg, " +
                progressColor +
                " 0%, " +
                progressColor +
                "dd 100%); border-radius: 12px; padding: 20px; margin-bottom: 24px;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 48px; font-weight: 800; color: white; text-align: center; margin-bottom: 8px;",
              },
              String(inputs.percent.toFixed(1)) + "%",
            ),
            h(
              "div",
              {
                style:
                  "background: rgba(255,255,255,0.2); border-radius: 8px; height: 12px; overflow: hidden; margin-bottom: 12px;",
              },
              h("div", {
                style: "background: white; height: 100%; width: " +
                  progressBarWidth +
                  "; transition: width 0.3s ease;",
              }),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; color: white; font-size: 14px;",
              },
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  { style: "font-size: 24px; font-weight: 700;" },
                  String(inputs.completed),
                ),
                h("div", { style: "opacity: 0.9;" }, "Completed"),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  { style: "font-size: 24px; font-weight: 700;" },
                  String(inputs.total),
                ),
                h("div", { style: "opacity: 0.9;" }, "Total Weight"),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  { style: "font-size: 24px; font-weight: 700;" },
                  String(inputs.remaining),
                ),
                h("div", { style: "opacity: 0.9;" }, "Remaining"),
              ),
            ),
          ),
          h(
            "h2",
            {
              style:
                "font-size: 20px; color: #1e293b; margin: 0 0 16px 0; font-weight: 600;",
            },
            "Milestones",
          ),
          h(
            "div",
            {
              style:
                "display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px;",
            },
            ...milestoneElements,
          ),
        ),
      );
    })({
      list: milestoneList,
      percent: completionPercent,
      completed: completedWeight,
      total: totalWeight,
      remaining: remainingWeight,
    });

    const ui = (
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          maxWidth: "800px",
          margin: "0 auto",
          padding: "20px",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        {milestonesDisplay}
        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginTop: "20px",
          }}
        >
          <h3
            style={{
              margin: "0 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
            }}
          >
            Add New Milestone
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              marginBottom: "24px",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                ID
              </label>
              <ct-input
                id="milestone-id-input"
                $value={milestoneIdField}
                placeholder="e.g., kickoff"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Label
              </label>
              <ct-input
                id="milestone-label-input"
                $value={labelField}
                placeholder="e.g., Kickoff review"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Weight
              </label>
              <ct-input
                id="milestone-weight-input"
                $value={weightField}
                placeholder="e.g., 30"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <ct-button
              id="add-milestone-button"
              onClick={addMilestone}
              style={{
                width: "100%",
                padding: "12px",
                background: "#10b981",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Add Milestone
            </ct-button>
          </div>

          <h3
            style={{
              margin: "24px 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
              paddingTop: "24px",
              borderTop: "2px solid #e2e8f0",
            }}
          >
            Update Existing
          </h3>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Milestone ID
              </label>
              <ct-input
                $value={milestoneIdField}
                placeholder="e.g., kickoff, design, launch"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <ct-button
                onClick={toggleMilestone}
                style={{
                  flex: "1",
                  padding: "12px",
                  background: "#3b82f6",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: "600",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Toggle Complete
              </ct-button>
            </div>
            <div
              style={{
                marginTop: "8px",
                paddingTop: "16px",
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <label
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                New Weight
              </label>
              <ct-input
                $value={weightField}
                placeholder="e.g., 50"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                  marginBottom: "12px",
                }}
              />
              <ct-button
                onClick={adjustWeight}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "#8b5cf6",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: "600",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Update Weight
              </ct-button>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      // Export writeable cell for direct manipulation
      milestonesInput: milestones,
      milestones: sanitized,
      milestoneList,
      totalWeight,
      completedWeight,
      remainingWeight,
      completionPercent,
      summary,
      complete: updateMilestoneCompletion({ milestones }),
      reweight: adjustMilestoneWeight({ milestones }),
    };
  },
);
