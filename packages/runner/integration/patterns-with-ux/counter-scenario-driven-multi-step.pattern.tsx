/// <cts-enable />
// @ts-nocheck
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

interface MultiStepArgs {
  value: Default<number, 0>;
  phase: Default<string, "idle">;
}

interface StartSequenceEvent {
  label?: unknown;
}

interface StepEvent {
  amount?: unknown;
  note?: unknown;
}

interface CompleteEvent {
  note?: unknown;
}

interface StepEntry {
  index: number;
  delta: number;
  total: number;
  note: string;
}

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return fallback;
  }
  return input;
};

const toSafeString = (input: unknown, fallback: string): string => {
  if (typeof input !== "string" || input.trim().length === 0) {
    return fallback;
  }
  return input.trim();
};

const sanitizeStepEntries = (input: unknown): StepEntry[] => {
  if (!Array.isArray(input)) return [];
  const result: StepEntry[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const index = toNumber((value as StepEntry).index, Number.NaN);
    const delta = toNumber((value as StepEntry).delta, Number.NaN);
    const total = toNumber((value as StepEntry).total, Number.NaN);
    const note = toSafeString((value as StepEntry).note, "step");
    if (
      Number.isFinite(index) &&
      Number.isFinite(delta) &&
      Number.isFinite(total)
    ) {
      result.push({
        index,
        delta,
        total,
        note,
      });
    }
  }
  return result;
};

const startSequence = handler(
  (
    event: StartSequenceEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const label = toSafeString(event?.label, "active");
    const currentValue = context.value.get();
    context.phase.set(label);
    context.value.set(toNumber(currentValue, 0));
    context.stepIndex.set(0);
    context.stepLog.set([]);
  },
);

const applyStep = handler(
  (
    event: StepEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const currentPhase = context.phase.get();
    const delta = toNumber(event?.amount, 1);
    const note = toSafeString(
      event?.note,
      `step ${toSafeString(currentPhase, "active")}`,
    );

    const rawValue = context.value.get();
    const current = toNumber(rawValue, 0);
    const next = current + delta;
    context.value.set(next);

    const rawIndex = context.stepIndex.get();
    const index = toNumber(rawIndex, 0) + 1;
    context.stepIndex.set(index);

    const log = sanitizeStepEntries(context.stepLog.get());
    log.push({ index, delta, total: next, note });
    context.stepLog.set(log);
  },
);

const completeSequence = handler(
  (
    event: CompleteEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepLog: Cell<StepEntry[]>;
      phaseHistory: Cell<string[]>;
    },
  ) => {
    const phaseValue = toSafeString(context.phase.get(), "active");
    const note = toSafeString(event?.note, "complete");
    const steps = sanitizeStepEntries(context.stepLog.get());
    const total = toNumber(context.value.get(), 0);

    const history = Array.isArray(context.phaseHistory.get())
      ? context.phaseHistory.get()
      : [];
    const summary =
      `${phaseValue} (${note}) steps: ${steps.length} total: ${total}`;
    context.phaseHistory.set([...history, summary]);
  },
);

export const counterWithScenarioDrivenStepsUx = recipe<MultiStepArgs>(
  "Counter With Scenario Driven Multi Step Events (UX)",
  ({ value, phase }) => {
    const stepIndex = cell(0);
    const stepLog = cell<StepEntry[]>([]);
    const phaseHistory = cell<string[]>([]);

    const currentValue = lift((input: unknown) => toNumber(input, 0))(value);
    const currentPhase = lift((input: unknown) => toSafeString(input, "idle"))(
      phase,
    );
    const steps = lift(sanitizeStepEntries)(stepLog);
    const completedPhases = lift((input: unknown) => {
      if (!Array.isArray(input)) return [];
      const result: string[] = [];
      for (const value of input) {
        result.push(toSafeString(value, "unknown phase"));
      }
      return result;
    })(phaseHistory);

    const stepCount = derive(steps, (entries) => entries.length);
    const lastRecordedTotal = derive(steps, (entries) => {
      if (entries.length === 0) {
        return currentValue.get();
      }
      return entries[entries.length - 1].total;
    });

    const summary =
      str`Phase ${currentPhase} total ${currentValue} over ${stepCount} steps`;

    // UI-specific cells
    const labelField = cell<string>("");
    const amountField = cell<string>("");
    const noteField = cell<string>("");
    const completeNoteField = cell<string>("");

    // UI handlers
    const startSequenceUI = handler(
      (
        _event: unknown,
        context: {
          phase: Cell<string>;
          value: Cell<number>;
          stepIndex: Cell<number>;
          stepLog: Cell<StepEntry[]>;
          labelField: Cell<string>;
        },
      ) => {
        const labelStr = context.labelField.get();
        const label = toSafeString(labelStr, "active");
        const currentValue = context.value.get();
        context.phase.set(label);
        context.value.set(toNumber(currentValue, 0));
        context.stepIndex.set(0);
        context.stepLog.set([]);
        context.labelField.set("");
      },
    );

    const applyStepUI = handler(
      (
        _event: unknown,
        context: {
          phase: Cell<string>;
          value: Cell<number>;
          stepIndex: Cell<number>;
          stepLog: Cell<StepEntry[]>;
          amountField: Cell<string>;
          noteField: Cell<string>;
        },
      ) => {
        const amountStr = context.amountField.get();
        const noteStr = context.noteField.get();

        const currentPhase = context.phase.get();
        const delta = toNumber(Number(amountStr), 1);
        const note = toSafeString(
          noteStr,
          `step ${toSafeString(currentPhase, "active")}`,
        );

        const rawValue = context.value.get();
        const current = toNumber(rawValue, 0);
        const next = current + delta;
        context.value.set(next);

        const rawIndex = context.stepIndex.get();
        const index = toNumber(rawIndex, 0) + 1;
        context.stepIndex.set(index);

        const log = sanitizeStepEntries(context.stepLog.get());
        log.push({ index, delta, total: next, note });
        context.stepLog.set(log);

        context.amountField.set("");
        context.noteField.set("");
      },
    );

    const completeSequenceUI = handler(
      (
        _event: unknown,
        context: {
          phase: Cell<string>;
          value: Cell<number>;
          stepLog: Cell<StepEntry[]>;
          phaseHistory: Cell<string[]>;
          completeNoteField: Cell<string>;
        },
      ) => {
        const noteStr = context.completeNoteField.get();
        const phaseValue = toSafeString(context.phase.get(), "active");
        const note = toSafeString(noteStr, "complete");
        const steps = sanitizeStepEntries(context.stepLog.get());
        const total = toNumber(context.value.get(), 0);

        const history = Array.isArray(context.phaseHistory.get())
          ? context.phaseHistory.get()
          : [];
        const summary =
          `${phaseValue} (${note}) steps: ${steps.length} total: ${total}`;
        context.phaseHistory.set([...history, summary]);
        context.completeNoteField.set("");
      },
    );

    const startBound = startSequenceUI({
      phase,
      value,
      stepIndex,
      stepLog,
      labelField,
    });
    const applyBound = applyStepUI({
      phase,
      value,
      stepIndex,
      stepLog,
      amountField,
      noteField,
    });
    const completeBound = completeSequenceUI({
      phase,
      value,
      stepLog,
      phaseHistory,
      completeNoteField,
    });

    const name = str`Multi-Step: ${currentPhase} (${stepCount} steps)`;

    // Phase status indicator
    const phaseStatusColor = lift((phaseStr: string) => {
      if (phaseStr === "idle") return "#94a3b8";
      return "#10b981";
    })(currentPhase);

    const phaseStatusStyle = lift((color: string) => {
      return "background: " + color +
        "; color: white; padding: 8px 16px; border-radius: 8px; " +
        "font-weight: 600; font-size: 14px; display: inline-block;";
    })(phaseStatusColor);

    // Step log display
    const stepLogDisplay = lift((inputs: {
      stepEntries: StepEntry[];
    }) => {
      const stepEntries = inputs.stepEntries;
      const elements = [];

      for (let i = stepEntries.length - 1; i >= 0; i--) {
        const step = stepEntries[i];
        const deltaColor = step.delta >= 0 ? "#10b981" : "#ef4444";
        const deltaSign = step.delta >= 0 ? "+" : "";

        const card = h(
          "div",
          {
            style: "background: white; border: 2px solid #e2e8f0; " +
              "border-radius: 8px; padding: 12px; " +
              "display: flex; justify-content: space-between; " +
              "align-items: center;",
          },
          h(
            "div",
            { style: "display: flex; flex-direction: column; gap: 4px;" },
            h(
              "span",
              { style: "font-weight: 600; color: #1e293b; font-size: 14px;" },
              "Step " + String(step.index),
            ),
            h(
              "span",
              { style: "color: #64748b; font-size: 12px;" },
              step.note,
            ),
          ),
          h(
            "div",
            {
              style: "display: flex; align-items: center; gap: 16px; " +
                "font-family: monospace;",
            },
            h(
              "span",
              {
                style: "color: " + deltaColor +
                  "; font-weight: 700; font-size: 16px;",
              },
              deltaSign + String(step.delta),
            ),
            h(
              "span",
              {
                style: "color: #1e293b; font-weight: 800; font-size: 20px;",
              },
              "= " + String(step.total),
            ),
          ),
        );
        elements.push(card);
      }

      if (stepEntries.length === 0) {
        return h(
          "div",
          {
            style: "background: white; border: 2px dashed #cbd5e1; " +
              "border-radius: 8px; padding: 24px; text-align: center;",
          },
          h(
            "p",
            { style: "color: #94a3b8; font-size: 14px; margin: 0;" },
            "No steps yet. Start a sequence and apply steps to see them here.",
          ),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column; gap: 8px;" },
        ...elements,
      );
    })({
      stepEntries: steps,
    });

    // Phase history display
    const phaseHistoryDisplay = lift((phases: string[]) => {
      const elements = [];

      for (let i = phases.length - 1; i >= 0; i--) {
        const phaseEntry = phases[i];
        const card = h(
          "div",
          {
            style: "background: #f8fafc; border-left: 4px solid #8b5cf6; " +
              "padding: 12px; border-radius: 4px;",
          },
          h(
            "span",
            {
              style: "color: #475569; font-size: 13px; font-family: monospace;",
            },
            phaseEntry,
          ),
        );
        elements.push(card);
      }

      if (phases.length === 0) {
        return h(
          "div",
          {
            style: "background: white; border: 2px dashed #cbd5e1; " +
              "border-radius: 8px; padding: 24px; text-align: center;",
          },
          h(
            "p",
            { style: "color: #94a3b8; font-size: 14px; margin: 0;" },
            "No completed phases yet.",
          ),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column; gap: 8px;" },
        ...elements,
      );
    })(completedPhases);

    const ui = (
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          maxWidth: "900px",
          margin: "0 auto",
          padding: "20px",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "28px",
              color: "#1e293b",
              fontWeight: "700",
            }}
          >
            Multi-Step Scenario Counter
          </h1>
          <p
            style={{
              margin: "0 0 24px 0",
              color: "#64748b",
              fontSize: "14px",
            }}
          >
            Track counters through multi-step sequences with phase management
          </p>

          <div
            style={{
              background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
              borderRadius: "12px",
              padding: "24px",
              marginBottom: "24px",
            }}
          >
            <div
              style={{
                fontSize: "64px",
                fontWeight: "900",
                color: "white",
                textAlign: "center",
                marginBottom: "16px",
                fontFamily: "monospace",
              }}
            >
              {currentValue}
            </div>
            <div
              style={{
                textAlign: "center",
                color: "white",
                fontSize: "16px",
                opacity: "0.95",
                fontWeight: "500",
                marginBottom: "16px",
              }}
            >
              Current Total
            </div>
            <div style={{ textAlign: "center" }}>
              <span style={phaseStatusStyle}>{currentPhase}</span>
            </div>
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
                background: "#f8fafc",
                borderRadius: "8px",
                padding: "16px",
                border: "2px solid #e2e8f0",
              }}
            >
              <div
                style={{
                  fontSize: "13px",
                  color: "#64748b",
                  marginBottom: "4px",
                  fontWeight: "600",
                }}
              >
                STEPS IN PHASE
              </div>
              <div
                style={{
                  fontSize: "28px",
                  fontWeight: "800",
                  color: "#1e293b",
                  fontFamily: "monospace",
                }}
              >
                {stepCount}
              </div>
            </div>
            <div
              style={{
                background: "#f8fafc",
                borderRadius: "8px",
                padding: "16px",
                border: "2px solid #e2e8f0",
              }}
            >
              <div
                style={{
                  fontSize: "13px",
                  color: "#64748b",
                  marginBottom: "4px",
                  fontWeight: "600",
                }}
              >
                COMPLETED PHASES
              </div>
              <div
                style={{
                  fontSize: "28px",
                  fontWeight: "800",
                  color: "#1e293b",
                  fontFamily: "monospace",
                }}
              >
                {completedPhases}
              </div>
            </div>
          </div>

          <h2
            style={{
              fontSize: "20px",
              color: "#1e293b",
              margin: "0 0 16px 0",
              fontWeight: "600",
            }}
          >
            Current Phase Steps
          </h2>
          {stepLogDisplay}
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
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
            Start New Sequence
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
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
                Phase Label
              </label>
              <ct-input
                $value={labelField}
                placeholder="e.g., sprint-1, batch-a"
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
              onClick={startBound}
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
              Start Sequence
            </ct-button>
          </div>
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
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
            Apply Step
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
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
                Amount
              </label>
              <ct-input
                $value={amountField}
                placeholder="e.g., 5 or -3"
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
                Note
              </label>
              <ct-input
                $value={noteField}
                placeholder="e.g., 'completed task A'"
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
              onClick={applyBound}
              style={{
                width: "100%",
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
              Apply Step
            </ct-button>
          </div>
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginBottom: "20px",
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
            Complete Current Sequence
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
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
                Completion Note
              </label>
              <ct-input
                $value={completeNoteField}
                placeholder="e.g., 'success', 'finished'"
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
              onClick={completeBound}
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
              Complete Sequence
            </ct-button>
          </div>
        </div>

        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
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
            Completed Phases History
          </h3>
          {phaseHistoryDisplay}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      value,
      phase,
      currentValue,
      currentPhase,
      stepCount,
      steps,
      lastRecordedTotal,
      phases: completedPhases,
      summary,
      sequence: {
        start: startSequence({ phase, value, stepIndex, stepLog }),
        apply: applyStep({ phase, value, stepIndex, stepLog }),
        complete: completeSequence({
          phase,
          value,
          stepLog,
          phaseHistory,
        }),
      },
    };
  },
);
