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

type WorkflowStage =
  | "draft"
  | "in_review"
  | "approved"
  | "scheduled"
  | "published"
  | "archived";

interface WorkflowArgs {
  stage: Default<WorkflowStage, "draft">;
}

interface TransitionEvent {
  target?: unknown;
  note?: unknown;
}

type TransitionResult = "accepted" | "rejected";

interface TransitionRecord {
  id: number;
  from: WorkflowStage;
  to: WorkflowStage;
  result: TransitionResult;
  note: string;
  reason: string;
}

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;

const ALLOWED_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["scheduled", "draft"],
  scheduled: ["published", "draft"],
  published: ["archived"],
  archived: [],
};

const isStage = (value: unknown): value is WorkflowStage => {
  if (typeof value !== "string") {
    return false;
  }
  return WORKFLOW_STAGES.includes(value as WorkflowStage);
};

const sanitizeStage = (value: unknown): WorkflowStage => {
  if (isStage(value)) {
    return value;
  }
  return "draft";
};

const sanitizeNote = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeSequence = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return 0;
};

const recordTransition = (
  history: Cell<TransitionRecord[]>,
  sequence: Cell<number>,
  entry: Omit<TransitionRecord, "id">,
) => {
  const existing = history.get();
  const current = Array.isArray(existing) ? existing : [];
  const baseId = sanitizeSequence(sequence.get());
  const next: TransitionRecord = { ...entry, id: baseId };
  history.set([...current, next]);
  sequence.set(baseId + 1);
};

const attemptStageTransition = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      stage: Cell<WorkflowStage>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = sanitizeStage(context.stage.get());
    const rawTarget = event?.target;
    const target = isStage(rawTarget) ? rawTarget : undefined;

    if (!target) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: current,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->invalid`,
        ),
        reason: "invalid-target",
      });
      return;
    }

    if (target === current) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: current,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->${target}`,
        ),
        reason: "no-op",
      });
      return;
    }

    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: target,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->${target}`,
        ),
        reason: "not-allowed",
      });
      return;
    }

    context.stage.set(target);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: target,
      result: "accepted",
      note: sanitizeNote(
        event?.note,
        `accept:${current}->${target}`,
      ),
      reason: "transition",
    });
  },
);

const stageLabels: Record<WorkflowStage, string> = {
  draft: "Draft",
  in_review: "In Review",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
};

const stageColors: Record<WorkflowStage, string> = {
  draft: "#94a3b8",
  in_review: "#3b82f6",
  approved: "#8b5cf6",
  scheduled: "#06b6d4",
  published: "#10b981",
  archived: "#64748b",
};

export const workflowStateMachineUx = recipe<WorkflowArgs>(
  "Workflow State Machine (UX)",
  ({ stage }) => {
    const transitions = cell<TransitionRecord[]>([]);
    const sequence = cell(0);

    const normalizedStage = lift((value: WorkflowStage | undefined) =>
      sanitizeStage(value)
    )(stage);

    const historyView = lift((entries: TransitionRecord[] | undefined) =>
      Array.isArray(entries) ? entries.slice() : []
    )(transitions);

    const attemptCount = lift((entries: TransitionRecord[]) => entries.length)(
      historyView,
    );

    const acceptedCount = lift((entries: TransitionRecord[]) =>
      entries.reduce(
        (count, entry) => count + (entry.result === "accepted" ? 1 : 0),
        0,
      )
    )(historyView);

    const rejectedCount = lift((entries: TransitionRecord[]) =>
      entries.reduce(
        (count, entry) => count + (entry.result === "rejected" ? 1 : 0),
        0,
      )
    )(historyView);

    const stageIndex = lift((current: WorkflowStage) =>
      WORKFLOW_STAGES.indexOf(current)
    )(normalizedStage);

    const availableTransitions = lift((current: WorkflowStage) => {
      const allowed = ALLOWED_TRANSITIONS[current] ?? [];
      return [...allowed];
    })(normalizedStage);

    const availableLabel = lift(
      (options: WorkflowStage[]) =>
        options.length === 0 ? "none" : options.join(","),
    )(availableTransitions);

    const stageMetadata = lift((current: WorkflowStage) =>
      WORKFLOW_STAGES.map((stageName) => ({
        stage: stageName,
        isCurrent: stageName === current,
        isReachable: (ALLOWED_TRANSITIONS[current] ?? [])
          .includes(stageName),
      }))
    )(normalizedStage);

    const lastTransitionStatus = lift((entries: TransitionRecord[]) => {
      const entry = entries.at(-1);
      if (!entry) {
        return "none";
      }
      return `${entry.result}:${entry.from}->${entry.to}`;
    })(historyView);

    const summary = lift(
      ({
        stage: stageVal,
        attempts,
        accepted,
        rejected,
      }: {
        stage: WorkflowStage;
        attempts: number;
        accepted: number;
        rejected: number;
      }) =>
        `stage:${stageVal} attempts:${attempts}` +
        ` accepted:${accepted} rejected:${rejected}`,
    )({
      stage: normalizedStage,
      attempts: attemptCount,
      accepted: acceptedCount,
      rejected: rejectedCount,
    });

    const name = str`Workflow (${normalizedStage})`;

    // UI cells for transition
    const targetStageField = cell<string>("");
    const noteField = cell<string>("");

    const transitionHandler = handler<
      unknown,
      {
        stage: Cell<WorkflowStage>;
        history: Cell<TransitionRecord[]>;
        sequence: Cell<number>;
        targetField: Cell<string>;
        noteField: Cell<string>;
      }
    >((_event, { stage, history, sequence, targetField, noteField }) => {
      const targetRaw = targetField.get();
      const noteRaw = noteField.get();

      // Replicate the attemptStageTransition logic directly
      const current = sanitizeStage(stage.get());
      const target = isStage(targetRaw) ? targetRaw : undefined;

      if (!target) {
        recordTransition(history, sequence, {
          from: current,
          to: current,
          result: "rejected",
          note: sanitizeNote(noteRaw, `reject:${current}->invalid`),
          reason: "invalid-target",
        });
        targetField.set("");
        noteField.set("");
        return;
      }

      if (target === current) {
        recordTransition(history, sequence, {
          from: current,
          to: current,
          result: "rejected",
          note: sanitizeNote(noteRaw, `reject:${current}->${target}`),
          reason: "no-op",
        });
        targetField.set("");
        noteField.set("");
        return;
      }

      const allowed = ALLOWED_TRANSITIONS[current] ?? [];
      if (!allowed.includes(target)) {
        recordTransition(history, sequence, {
          from: current,
          to: target,
          result: "rejected",
          note: sanitizeNote(noteRaw, `reject:${current}->${target}`),
          reason: "not-allowed",
        });
        targetField.set("");
        noteField.set("");
        return;
      }

      stage.set(target);
      recordTransition(history, sequence, {
        from: current,
        to: target,
        result: "accepted",
        note: sanitizeNote(noteRaw, `accept:${current}->${target}`),
        reason: "transition",
      });

      // Clear fields after successful transition
      targetField.set("");
      noteField.set("");
    })({
      stage,
      history: transitions,
      sequence,
      targetField: targetStageField,
      noteField: noteField,
    });

    const progressPercent = lift((index: number) => {
      const total = WORKFLOW_STAGES.length - 1;
      return Math.round((index / total) * 100);
    })(stageIndex);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
            background: linear-gradient(to bottom, #f8fafc, #ffffff);
            padding: 1rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #64748b;
                    font-size: 0.7rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Workflow State Machine
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.4rem;
                    color: #0f172a;
                  ">
                  Track transitions through workflow stages
                </h2>
              </div>

              <div
                style={lift((current: WorkflowStage) => {
                  const color = stageColors[current];
                  return "background: linear-gradient(135deg, " +
                    color +
                    "15, " +
                    color +
                    "05); border: 2px solid " +
                    color +
                    "; border-radius: 0.75rem; padding: 1.25rem; display: flex; justify-content: space-between; align-items: center;";
                })(normalizedStage)}
              >
                <div>
                  <div style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.25rem;">
                    Current Stage
                  </div>
                  <div style="font-size: 1.5rem; font-weight: 700; color: #0f172a;">
                    {lift((current: WorkflowStage) => stageLabels[current])(
                      normalizedStage,
                    )}
                  </div>
                  <div style="font-size: 0.85rem; color: #475569; margin-top: 0.25rem;">
                    {lift((index: number) =>
                      `Step ${index + 1} of ${WORKFLOW_STAGES.length}`
                    )(stageIndex)}
                  </div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;">
                  <div style="font-size: 2rem; font-weight: 700; color: #0f172a;">
                    {progressPercent}%
                  </div>
                  <div style="
                      width: 8rem;
                      height: 0.5rem;
                      background: #e2e8f0;
                      border-radius: 0.25rem;
                      overflow: hidden;
                    ">
                    <div
                      style={lift((percent: number) =>
                        "width: " +
                        String(percent) +
                        "%; height: 100%; background: #10b981; transition: width 0.3s;"
                      )(progressPercent)}
                    />
                  </div>
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 1rem;
                ">
                <div style="text-align: center; padding: 0.75rem; background: #f8fafc; border-radius: 0.5rem;">
                  <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                    Total
                  </div>
                  <div style="font-size: 1.5rem; font-weight: 700; color: #0f172a;">
                    {attemptCount}
                  </div>
                </div>
                <div style="text-align: center; padding: 0.75rem; background: #dcfce7; border-radius: 0.5rem;">
                  <div style="font-size: 0.7rem; color: #166534; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                    Accepted
                  </div>
                  <div style="font-size: 1.5rem; font-weight: 700; color: #16a34a;">
                    {acceptedCount}
                  </div>
                </div>
                <div style="text-align: center; padding: 0.75rem; background: #fee2e2; border-radius: 0.5rem;">
                  <div style="font-size: 0.7rem; color: #991b1b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">
                    Rejected
                  </div>
                  <div style="font-size: 1.5rem; font-weight: 700; color: #dc2626;">
                    {rejectedCount}
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Workflow Stages
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {lift(
                (
                  metadata: Array<
                    {
                      stage: WorkflowStage;
                      isCurrent: boolean;
                      isReachable: boolean;
                    }
                  >,
                ) => {
                  const elements = [];
                  for (let idx = 0; idx < metadata.length; idx++) {
                    const item = metadata[idx];
                    const color = stageColors[item.stage];
                    const bgColor = item.isCurrent
                      ? color + "20"
                      : item.isReachable
                      ? color + "08"
                      : "#f8fafc";
                    const borderColor = item.isCurrent
                      ? color
                      : item.isReachable
                      ? color + "60"
                      : "#e2e8f0";
                    const textColor = item.isCurrent
                      ? "#0f172a"
                      : item.isReachable
                      ? "#475569"
                      : "#94a3b8";

                    const stageStyle =
                      "display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border: 2px solid " +
                      borderColor +
                      "; border-radius: 0.5rem; background: " +
                      bgColor +
                      "; transition: all 0.2s;";

                    const indicatorStyle =
                      "width: 0.75rem; height: 0.75rem; border-radius: 50%; background: " +
                      (item.isCurrent
                        ? color
                        : item.isReachable
                        ? color + "80"
                        : "#cbd5e1") +
                      ";";

                    elements.push(
                      <div key={item.stage} style={stageStyle}>
                        <span style={indicatorStyle} />
                        <span
                          style={"flex: 1; font-weight: " +
                            (item.isCurrent ? "600" : "400") +
                            "; color: " +
                            textColor +
                            ";"}
                        >
                          {stageLabels[item.stage]}
                        </span>
                        {item.isCurrent
                          ? (
                            <span style="
                              padding: 0.125rem 0.5rem;
                              background: #10b981;
                              color: white;
                              border-radius: 0.25rem;
                              font-size: 0.7rem;
                              font-weight: 600;
                              text-transform: uppercase;
                              letter-spacing: 0.05em;
                            ">
                              Current
                            </span>
                          )
                          : null}
                        {!item.isCurrent && item.isReachable
                          ? (
                            <span style="
                              padding: 0.125rem 0.5rem;
                              background: #3b82f6;
                              color: white;
                              border-radius: 0.25rem;
                              font-size: 0.7rem;
                              font-weight: 600;
                              text-transform: uppercase;
                              letter-spacing: 0.05em;
                            ">
                              Available
                            </span>
                          )
                          : null}
                      </div>,
                    );
                  }
                  return elements;
                },
              )(stageMetadata)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Request Transition
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  padding: 0.75rem;
                  background: #fffbeb;
                  border: 1px solid #fbbf24;
                  border-radius: 0.5rem;
                  font-size: 0.85rem;
                  color: #92400e;
                ">
                <strong>Available transitions:</strong> {availableLabel}
              </div>
              <div style="display: flex; gap: 1rem;">
                <div style="flex: 2;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Target Stage
                  </label>
                  <ct-input
                    $value={targetStageField}
                    placeholder="e.g., in_review, approved..."
                    style="width: 100%;"
                  />
                </div>
                <div style="flex: 2;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Note (optional)
                  </label>
                  <ct-input
                    $value={noteField}
                    placeholder="Transition note..."
                    style="width: 100%;"
                  />
                </div>
              </div>
              <div>
                <ct-button onClick={transitionHandler}>
                  Attempt Transition
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Transition History
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 24rem;
                overflow-y: auto;
              "
            >
              {lift((entries: TransitionRecord[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 2rem;
                        color: #64748b;
                        font-size: 0.9rem;
                      ">
                      No transitions yet. Request a transition to get started.
                    </div>
                  );
                }

                const elements = [];
                const reversed = entries.slice().reverse();
                for (let idx = 0; idx < reversed.length; idx++) {
                  const entry = reversed[idx];
                  const isAccepted = entry.result === "accepted";
                  const bgColor = isAccepted ? "#dcfce7" : "#fee2e2";
                  const borderColor = isAccepted ? "#16a34a" : "#dc2626";
                  const badgeColor = isAccepted ? "#10b981" : "#ef4444";
                  const badgeText = isAccepted ? "✓ ACCEPTED" : "✗ REJECTED";

                  const reasonLabels: Record<string, string> = {
                    transition: "Valid transition",
                    "not-allowed": "Not allowed from current stage",
                    "no-op": "Already in target stage",
                    "invalid-target": "Invalid target stage",
                  };

                  const entryStyle = "padding: 0.75rem; background: " +
                    bgColor +
                    "; border-left: 4px solid " +
                    borderColor +
                    "; border-radius: 0.5rem;";

                  const badgeStyle =
                    "display: inline-block; padding: 0.125rem 0.5rem; background: " +
                    badgeColor +
                    "; color: white; border-radius: 0.25rem; font-size: 0.7rem; font-weight: 600;";

                  elements.push(
                    <div key={entry.id} style={entryStyle}>
                      <div style="
                          display: flex;
                          justify-content: space-between;
                          align-items: start;
                          gap: 1rem;
                        ">
                        <div style="flex: 1;">
                          <div style="
                              display: flex;
                              align-items: center;
                              gap: 0.5rem;
                              margin-bottom: 0.25rem;
                            ">
                            <span style={badgeStyle}>
                              {badgeText}
                            </span>
                            <span style="
                                font-size: 0.75rem;
                                color: #64748b;
                                font-family: monospace;
                              ">
                              #{String(entry.id)}
                            </span>
                          </div>
                          <div style="
                              font-weight: 600;
                              color: #0f172a;
                              margin-bottom: 0.25rem;
                            ">
                            {stageLabels[entry.from]} → {stageLabels[entry.to]}
                          </div>
                          <div style="
                              font-size: 0.85rem;
                              color: #475569;
                              margin-bottom: 0.25rem;
                            ">
                            {reasonLabels[entry.reason] || entry.reason}
                          </div>
                          {entry.note
                            ? (
                              <div style="
                                  font-size: 0.8rem;
                                  color: #64748b;
                                  font-style: italic;
                                ">
                                "{entry.note}"
                              </div>
                            )
                            : null}
                        </div>
                      </div>
                    </div>,
                  );
                }
                return elements;
              })(historyView)}
            </div>
          </ct-card>
        </div>
      ),
      stage: normalizedStage,
      stageIndex,
      availableTransitions,
      availableLabel,
      stageMetadata,
      history: historyView,
      attemptCount,
      acceptedCount,
      rejectedCount,
      lastTransitionStatus,
      summary,
      transition: attemptStageTransition({
        stage,
        history: transitions,
        sequence,
      }),
    };
  },
);

export const pattern = workflowStateMachineUx;
