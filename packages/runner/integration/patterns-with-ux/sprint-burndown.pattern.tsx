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

interface BurndownEntry {
  day: number;
  remaining: number;
}

interface BurndownCurvePoint {
  day: number;
  actual: number | null;
  projected: number;
  ideal: number;
}

interface SprintSnapshotEvent {
  day?: number;
  completed?: number;
  remaining?: number;
  note?: string;
}

interface SprintBurndownArgs {
  totalScope: Default<number, 40>;
  sprintLength: Default<number, 10>;
  snapshots: Default<BurndownEntry[], []>;
}

interface LogMessageInput {
  day: number;
  burnedToday: number;
  totalBurned: number;
  remaining: number;
  note?: string;
}

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeScope = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 40;
  }
  return Math.max(0, roundToTwo(value));
};

const sanitizeSprintLength = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  const normalized = Math.max(1, Math.floor(value));
  return Math.min(normalized, 35);
};

const sanitizeCompleted = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, roundToTwo(value));
};

const sanitizeRemaining = (value: unknown, scope: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return scope;
  }
  const normalized = roundToTwo(value);
  if (normalized <= 0) return 0;
  if (normalized >= scope) return scope;
  return normalized;
};

const sanitizeDay = (
  value: unknown,
  sprintLength: number,
): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.floor(value));
  if (normalized > sprintLength) {
    return sprintLength;
  }
  return normalized;
};

const sanitizeSnapshots = (
  value: unknown,
  scope: number,
  sprintLength: number,
): BurndownEntry[] => {
  if (!Array.isArray(value)) {
    return [{ day: 0, remaining: scope }];
  }
  const map = new Map<number, BurndownEntry>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { day?: unknown; remaining?: unknown };
    const day = sanitizeDay(record.day, sprintLength);
    if (day === null) continue;
    const remaining = sanitizeRemaining(record.remaining, scope);
    map.set(day, { day, remaining });
  }
  map.set(0, { day: 0, remaining: scope });
  const result = Array.from(map.values());
  result.sort((left, right) => left.day - right.day);
  return result;
};

const upsertSnapshot = (
  history: readonly BurndownEntry[],
  entry: BurndownEntry,
): BurndownEntry[] => {
  const updated: BurndownEntry[] = [];
  let replaced = false;
  for (const item of history) {
    if (item.day === entry.day) {
      if (!replaced) {
        updated.push(entry);
        replaced = true;
      }
      continue;
    }
    updated.push(item);
  }
  if (!replaced) {
    updated.push(entry);
  }
  updated.sort((left, right) => left.day - right.day);
  return updated;
};

const findPreviousRemaining = (
  history: readonly BurndownEntry[],
  day: number,
  scope: number,
): number => {
  let previous = scope;
  for (const entry of history) {
    if (entry.day > day) break;
    previous = entry.remaining;
  }
  return previous;
};

const buildIdealLine = (
  scope: number,
  sprintLength: number,
): BurndownEntry[] => {
  if (sprintLength <= 0) {
    return [{ day: 0, remaining: scope }];
  }
  const length = Math.max(1, sprintLength);
  const result: BurndownEntry[] = [];
  for (let day = 0; day <= length; day++) {
    const ratio = day / length;
    const remaining = Math.max(0, roundToTwo(scope * (1 - ratio)));
    result.push({ day, remaining });
  }
  return result;
};

const buildBurndownCurve = (
  history: readonly BurndownEntry[],
  scope: number,
  sprintLength: number,
): BurndownCurvePoint[] => {
  const ideal = buildIdealLine(scope, sprintLength);
  const idealByDay = new Map<number, number>(
    ideal.map((entry) => [entry.day, entry.remaining] as const),
  );
  const dayToRemaining = new Map<number, number>();
  for (const entry of history) {
    dayToRemaining.set(entry.day, entry.remaining);
  }
  if (!dayToRemaining.has(0)) {
    dayToRemaining.set(0, scope);
  }
  const days = Array.from(dayToRemaining.keys()).sort((a, b) => a - b);
  const lastDay = days[days.length - 1] ?? 0;
  const lastRemaining = dayToRemaining.get(lastDay) ?? scope;
  const averageBurn = lastDay === 0
    ? 0
    : Math.max(0, roundToTwo((scope - lastRemaining) / lastDay));

  const points: BurndownCurvePoint[] = [];
  let projected = scope;
  for (let day = 0; day <= sprintLength; day++) {
    const actual = dayToRemaining.has(day) ? dayToRemaining.get(day)! : null;
    if (day === 0) {
      projected = scope;
    } else if (day <= lastDay) {
      if (actual !== null) {
        projected = actual;
      } else if (averageBurn > 0) {
        projected = Math.max(0, roundToTwo(projected - averageBurn));
      }
    } else if (averageBurn > 0) {
      projected = Math.max(0, roundToTwo(projected - averageBurn));
    }
    const idealRemaining = idealByDay.get(day) ??
      ideal[ideal.length - 1].remaining;
    points.push({ day, actual, projected, ideal: idealRemaining });
  }
  return points;
};

const appendLogEntry = (log: Cell<string[]>, entry: string) => {
  const previous = log.get();
  const list = Array.isArray(previous) ? previous.slice() : [];
  list.push(entry);
  const trimmed = list.length > 8 ? list.slice(-8) : list;
  log.set(trimmed);
};

const buildLogMessage = (input: LogMessageInput): string => {
  const summary =
    `Day ${input.day}: burned ${input.burnedToday} (total ${input.totalBurned})`;
  const remaining = ` remaining ${input.remaining}`;
  if (input.note && input.note.trim().length > 0) {
    return `${summary}${remaining} — ${input.note.trim()}`;
  }
  return `${summary}${remaining}`;
};

const logSprintProgress = handler(
  (
    event: SprintSnapshotEvent | undefined,
    context: {
      totalScope: Cell<number>;
      sprintLength: Cell<number>;
      snapshots: Cell<BurndownEntry[]>;
      log: Cell<string[]>;
      dayInput: Cell<string>;
      completedInput: Cell<string>;
      noteInput: Cell<string>;
    },
  ) => {
    const scope = sanitizeScope(context.totalScope.get());
    const length = sanitizeSprintLength(context.sprintLength.get());
    const history = sanitizeSnapshots(context.snapshots.get(), scope, length);

    const providedDay = sanitizeDay(event?.day, length);
    const lastRecorded = history[history.length - 1] ??
      { day: 0, remaining: scope };
    const candidateDay = providedDay ?? Math.min(lastRecorded.day + 1, length);

    const completed = sanitizeCompleted(event?.completed);
    const hasRemainingField = event ? Object.hasOwn(event, "remaining") : false;
    const explicitRemaining = hasRemainingField
      ? sanitizeRemaining(event?.remaining, scope)
      : null;

    const base = findPreviousRemaining(history, candidateDay, scope);
    const nextRemaining = explicitRemaining ?? Math.max(
      0,
      Math.min(scope, roundToTwo(base - completed)),
    );
    const updatedHistory = upsertSnapshot(history, {
      day: candidateDay,
      remaining: nextRemaining,
    });

    context.totalScope.set(scope);
    context.sprintLength.set(length);
    context.snapshots.set(updatedHistory);

    const burnedToday = roundToTwo(Math.max(0, base - nextRemaining));
    const totalBurned = roundToTwo(Math.max(0, scope - nextRemaining));
    const message = buildLogMessage({
      day: candidateDay,
      burnedToday,
      totalBurned,
      remaining: nextRemaining,
      note: typeof event?.note === "string" ? event?.note : undefined,
    });
    appendLogEntry(context.log, message);

    // Clear input fields after logging
    context.dayInput.set("");
    context.completedInput.set("");
    context.noteInput.set("");
  },
);

export const sprintBurndownUx = recipe<SprintBurndownArgs>(
  "Sprint Burndown Tracker (UX)",
  ({ totalScope, sprintLength, snapshots }) => {
    const activityLog = cell<string[]>([]);
    const dayInput = cell<string>("");
    const completedInput = cell<string>("");
    const noteInput = cell<string>("");

    const scopeView = lift((value: number | undefined) => sanitizeScope(value))(
      totalScope,
    );

    const lengthView = lift((value: number | undefined) =>
      sanitizeSprintLength(value)
    )(sprintLength);

    const historyView = lift((input: {
      list: BurndownEntry[];
      scope: number;
      length: number;
    }) => sanitizeSnapshots(input.list, input.scope, input.length))({
      list: snapshots,
      scope: scopeView,
      length: lengthView,
    });

    const lastDayView = lift((entries: BurndownEntry[]) => {
      const last = entries[entries.length - 1];
      return last ? last.day : 0;
    })(historyView);

    const remainingView = lift(
      (input: { history: BurndownEntry[]; scope: number }) => {
        const last = input.history[input.history.length - 1];
        return last ? last.remaining : input.scope;
      },
    )({ history: historyView, scope: scopeView });

    const burnedView = lift((input: { scope: number; remaining: number }) => {
      return roundToTwo(Math.max(0, input.scope - input.remaining));
    })({ scope: scopeView, remaining: remainingView });

    const completionView = lift((input: { burned: number; scope: number }) => {
      if (input.scope === 0) return 100;
      const ratio = (input.burned / input.scope) * 100;
      return Math.min(100, Math.max(0, Math.round(ratio)));
    })({ burned: burnedView, scope: scopeView });

    const idealLine = lift((input: { scope: number; length: number }) =>
      buildIdealLine(input.scope, input.length)
    )({ scope: scopeView, length: lengthView });

    const burndownCurve = lift((input: {
      history: BurndownEntry[];
      scope: number;
      length: number;
    }) => buildBurndownCurve(input.history, input.scope, input.length))({
      history: historyView,
      scope: scopeView,
      length: lengthView,
    });

    const activityLogView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(activityLog);

    const statusLabel =
      str`Day ${lastDayView}/${lengthView} — burned ${burnedView} (${completionView}%)`;

    const submitLog = handler(
      (
        _event: undefined,
        context: {
          totalScope: Cell<number>;
          sprintLength: Cell<number>;
          snapshots: Cell<BurndownEntry[]>;
          log: Cell<string[]>;
          dayInput: Cell<string>;
          completedInput: Cell<string>;
          noteInput: Cell<string>;
        },
      ) => {
        const dayStr = context.dayInput.get();
        const completedStr = context.completedInput.get();
        const note = context.noteInput.get();

        const event: SprintSnapshotEvent = {};
        if (dayStr && dayStr.trim()) {
          const dayNum = parseFloat(dayStr);
          if (!isNaN(dayNum)) {
            event.day = dayNum;
          }
        }
        if (completedStr && completedStr.trim()) {
          const completedNum = parseFloat(completedStr);
          if (!isNaN(completedNum)) {
            event.completed = completedNum;
          }
        }
        if (note && note.trim()) {
          event.note = note;
        }

        // Apply the same logic as logSprintProgress
        const scope = sanitizeScope(context.totalScope.get());
        const length = sanitizeSprintLength(context.sprintLength.get());
        const history = sanitizeSnapshots(
          context.snapshots.get(),
          scope,
          length,
        );

        const providedDay = sanitizeDay(event?.day, length);
        const lastRecorded = history[history.length - 1] ??
          { day: 0, remaining: scope };
        const candidateDay = providedDay ??
          Math.min(lastRecorded.day + 1, length);

        const completed = sanitizeCompleted(event?.completed);
        const hasRemainingField = event
          ? Object.hasOwn(event, "remaining")
          : false;
        const explicitRemaining = hasRemainingField
          ? sanitizeRemaining(event?.remaining, scope)
          : null;

        const base = findPreviousRemaining(history, candidateDay, scope);
        const nextRemaining = explicitRemaining ?? Math.max(
          0,
          Math.min(scope, roundToTwo(base - completed)),
        );
        const updatedHistory = upsertSnapshot(history, {
          day: candidateDay,
          remaining: nextRemaining,
        });

        context.totalScope.set(scope);
        context.sprintLength.set(length);
        context.snapshots.set(updatedHistory);

        const burnedToday = roundToTwo(Math.max(0, base - nextRemaining));
        const totalBurned = roundToTwo(Math.max(0, scope - nextRemaining));
        const message = buildLogMessage({
          day: candidateDay,
          burnedToday,
          totalBurned,
          remaining: nextRemaining,
          note: typeof event?.note === "string" ? event?.note : undefined,
        });
        appendLogEntry(context.log, message);

        // Clear input fields after logging
        context.dayInput.set("");
        context.completedInput.set("");
        context.noteInput.set("");
      },
    )({
      totalScope,
      sprintLength,
      snapshots,
      log: activityLog,
      dayInput,
      completedInput,
      noteInput,
    });

    const logHandler = logSprintProgress({
      totalScope,
      sprintLength,
      snapshots,
      log: activityLog,
      dayInput,
      completedInput,
      noteInput,
    });

    const name = str`Sprint Burndown (Day ${lastDayView}/${lengthView})`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    color: #10b981;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Agile Sprint Management
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                  ">
                  Sprint Burndown Tracker
                </h2>
                <p style="
                    margin: 0;
                    color: #64748b;
                    font-size: 0.95rem;
                    line-height: 1.5;
                  ">
                  Track your sprint progress with ideal, projected, and actual
                  burndown curves. Log daily completed work to visualize
                  velocity and forecast completion.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                  border-radius: 1rem;
                  padding: 1.5rem;
                  color: white;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 1rem;
                    margin-bottom: 1rem;
                  ">
                  <div>
                    <div style="
                        font-size: 0.85rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Current Sprint Day
                    </div>
                    <div style="
                        font-size: 2rem;
                        font-weight: 700;
                      ">
                      {lastDayView} / {lengthView}
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <div style="
                        font-size: 0.85rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Completion
                    </div>
                    <div style="
                        font-size: 2rem;
                        font-weight: 700;
                      ">
                      {completionView}%
                    </div>
                  </div>
                </div>

                <div style="
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 0.5rem;
                    padding: 1rem;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
                    gap: 1rem;
                  ">
                  <div>
                    <div style="
                        font-size: 0.75rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Total Scope
                    </div>
                    <div style="font-size: 1.25rem; font-weight: 600;">
                      {scopeView} pts
                    </div>
                  </div>
                  <div>
                    <div style="
                        font-size: 0.75rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Burned
                    </div>
                    <div style="font-size: 1.25rem; font-weight: 600;">
                      {burnedView} pts
                    </div>
                  </div>
                  <div>
                    <div style="
                        font-size: 0.75rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Remaining
                    </div>
                    <div style="font-size: 1.25rem; font-weight: 600;">
                      {remainingView} pts
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="font-size: 1.25rem;">📊</span>
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Burndown Chart
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
              {lift((curve: BurndownCurvePoint[]) => {
                const maxY = Math.max(
                  ...curve.map((p) =>
                    Math.max(p.ideal, p.projected, p.actual ?? 0)
                  ),
                );
                const chartHeight = 200;
                const chartWidth = 600;
                const padding = 40;
                const plotWidth = chartWidth - 2 * padding;
                const plotHeight = chartHeight - 2 * padding;

                const points: any[] = [];
                for (let i = 0; i < curve.length; i++) {
                  const point = curve[i];
                  const x = padding + (point.day / (curve.length - 1)) *
                      plotWidth;
                  const yIdeal = padding + plotHeight -
                    (point.ideal / maxY) * plotHeight;
                  const yProjected = padding + plotHeight -
                    (point.projected / maxY) * plotHeight;
                  const yActual = point.actual !== null
                    ? padding + plotHeight - (point.actual / maxY) * plotHeight
                    : null;

                  points.push({ x, yIdeal, yProjected, yActual });
                }

                let idealPath = `M ${points[0].x} ${points[0].yIdeal}`;
                for (let i = 1; i < points.length; i++) {
                  idealPath += ` L ${points[i].x} ${points[i].yIdeal}`;
                }

                let projectedPath = `M ${points[0].x} ${points[0].yProjected}`;
                for (let i = 1; i < points.length; i++) {
                  projectedPath += ` L ${points[i].x} ${points[i].yProjected}`;
                }

                let actualPath = "";
                let firstActual = true;
                for (let i = 0; i < points.length; i++) {
                  if (points[i].yActual !== null) {
                    if (firstActual) {
                      actualPath = `M ${points[i].x} ${points[i].yActual}`;
                      firstActual = false;
                    } else {
                      actualPath += ` L ${points[i].x} ${points[i].yActual}`;
                    }
                  }
                }

                return (
                  <svg
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                    style="
                      width: 100%;
                      height: auto;
                      background: #f8fafc;
                      border-radius: 0.5rem;
                    "
                  >
                    <path
                      d={idealPath}
                      stroke="#94a3b8"
                      stroke-width="2"
                      fill="none"
                      stroke-dasharray="5,5"
                    />
                    <path
                      d={projectedPath}
                      stroke="#f59e0b"
                      stroke-width="2"
                      fill="none"
                    />
                    {actualPath &&
                      (
                        <path
                          d={actualPath}
                          stroke="#10b981"
                          stroke-width="3"
                          fill="none"
                        />
                      )}
                    {(() => {
                      const circles: any[] = [];
                      for (let i = 0; i < points.length; i++) {
                        if (points[i].yActual !== null) {
                          circles.push(
                            <circle
                              cx={points[i].x}
                              cy={points[i].yActual}
                              r="4"
                              fill="#10b981"
                            />,
                          );
                        }
                      }
                      return circles;
                    })()}
                  </svg>
                );
              })(burndownCurve)}

              <div style="
                  display: flex;
                  gap: 1rem;
                  flex-wrap: wrap;
                  font-size: 0.85rem;
                ">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div style="
                      width: 1.5rem;
                      height: 2px;
                      background: #94a3b8;
                      border-top: 2px dashed #94a3b8;
                    ">
                  </div>
                  <span style="color: #64748b;">Ideal</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div style="
                      width: 1.5rem;
                      height: 2px;
                      background: #f59e0b;
                    ">
                  </div>
                  <span style="color: #64748b;">Projected</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div style="
                      width: 1.5rem;
                      height: 3px;
                      background: #10b981;
                    ">
                  </div>
                  <span style="color: #64748b;">Actual</span>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="font-size: 1.25rem;">✏️</span>
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Log Daily Progress
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
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
                  gap: 0.75rem;
                ">
                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                  <label style="
                      font-size: 0.85rem;
                      color: #64748b;
                      font-weight: 500;
                    ">
                    Day (optional)
                  </label>
                  <ct-input
                    type="number"
                    $value={dayInput}
                    placeholder="Auto"
                    style="
                      border: 1px solid #e2e8f0;
                      border-radius: 0.375rem;
                      padding: 0.5rem;
                    "
                  />
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                  <label style="
                      font-size: 0.85rem;
                      color: #64748b;
                      font-weight: 500;
                    ">
                    Points Completed
                  </label>
                  <ct-input
                    type="number"
                    $value={completedInput}
                    placeholder="0"
                    style="
                      border: 1px solid #e2e8f0;
                      border-radius: 0.375rem;
                      padding: 0.5rem;
                    "
                  />
                </div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <label style="
                    font-size: 0.85rem;
                    color: #64748b;
                    font-weight: 500;
                  ">
                  Note (optional)
                </label>
                <ct-input
                  type="text"
                  $value={noteInput}
                  placeholder="Team retrospective notes..."
                  style="
                    border: 1px solid #e2e8f0;
                    border-radius: 0.375rem;
                    padding: 0.5rem;
                  "
                />
              </div>

              <ct-button
                onClick={submitLog}
                style="
                  background: #10b981;
                  color: white;
                  border: none;
                  padding: 0.75rem 1.5rem;
                  font-weight: 600;
                  border-radius: 0.375rem;
                "
              >
                Log Progress
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="font-size: 1.25rem;">📋</span>
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Activity Log
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
              {lift((entries: string[]) => {
                if (entries.length === 0) {
                  return (
                    <p style="
                        margin: 0;
                        color: #94a3b8;
                        font-size: 0.9rem;
                        font-style: italic;
                      ">
                      No activity logged yet. Log your first day to start
                      tracking!
                    </p>
                  );
                }
                const reversed = entries.slice().reverse();
                const logs: any[] = [];
                for (let i = 0; i < reversed.length; i++) {
                  logs.push(
                    <div style="
                        padding: 0.75rem;
                        background: #f8fafc;
                        border-left: 3px solid #10b981;
                        border-radius: 0.25rem;
                        font-size: 0.9rem;
                        color: #334155;
                        font-family: monospace;
                      ">
                      {reversed[i]}
                    </div>,
                  );
                }
                return logs;
              })(activityLogView)}
            </div>
          </ct-card>
        </div>
      ),
      totalScope: scopeView,
      sprintLength: lengthView,
      history: historyView,
      remaining: remainingView,
      burned: burnedView,
      completion: completionView,
      idealLine,
      burndownCurve,
      activityLog: activityLogView,
      statusLabel,
      logDay: logHandler,
    };
  },
);

export default sprintBurndownUx;
