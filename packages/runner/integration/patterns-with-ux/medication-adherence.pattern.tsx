/// <cts-enable />
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

interface MedicationDoseSeed {
  id?: string;
  name?: string;
  dosage?: string;
  scheduledTime?: string;
  instructions?: string;
}

interface MedicationDose {
  id: string;
  medication: string;
  dosage: string;
  scheduledTime: string;
  instructions: string;
}

interface DoseRecord {
  id: string;
  medication: string;
  scheduledTime: string;
  takenAt: string;
}

interface AdherenceSnapshot {
  total: number;
  taken: number;
  pending: number;
  percentage: number;
}

interface MedicationAdherenceArgs {
  doses: Default<MedicationDoseSeed[], []>;
}

interface MarkDoseEvent {
  doseId?: string;
  takenAt?: string;
}

const timePattern = /^\d{2}:\d{2}$/;

const toHoursMinutes = (value: Date): string => {
  const hours = value.getUTCHours().toString().padStart(2, "0");
  const minutes = value.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
};

const sanitizeTime = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (timePattern.test(trimmed)) {
      return trimmed;
    }
    const attempt = new Date(trimmed);
    if (!Number.isNaN(attempt.getTime())) {
      return toHoursMinutes(attempt);
    }
  }
  return fallback;
};

const sanitizeDoseId = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeMedicationName = (
  value: unknown,
  fallbackIndex: number,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `Medication ${fallbackIndex + 1}`;
};

const sanitizeDosage = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "Standard dosage";
};

const sanitizeInstructions = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "Take with water";
};

const compareTimes = (left: string, right: string): number => {
  if (left === right) return 0;
  const [leftHours, leftMinutes] = left.split(":", 2);
  const [rightHours, rightMinutes] = right.split(":", 2);
  const leftValue = Number.parseInt(leftHours, 10) * 60 +
    Number.parseInt(leftMinutes, 10);
  const rightValue = Number.parseInt(rightHours, 10) * 60 +
    Number.parseInt(rightMinutes, 10);
  return leftValue - rightValue;
};

const toMedicationDose = (
  seed: MedicationDoseSeed | undefined,
  index: number,
  usedIds: Set<string>,
): MedicationDose => {
  const baseId = sanitizeDoseId(seed?.id, `dose-${index + 1}`);
  let id = baseId;
  let disambiguator = 1;
  while (usedIds.has(id)) {
    disambiguator += 1;
    id = `${baseId}-${disambiguator}`;
  }
  usedIds.add(id);
  const medication = sanitizeMedicationName(seed?.name, index);
  const dosage = sanitizeDosage(seed?.dosage);
  const scheduledTime = sanitizeTime(seed?.scheduledTime, "08:00");
  const instructions = sanitizeInstructions(seed?.instructions);
  return { id, medication, dosage, scheduledTime, instructions };
};

const sanitizeSchedule = (
  entries: readonly MedicationDoseSeed[] | undefined,
): MedicationDose[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const usedIds = new Set<string>();
  const sanitized = entries.map((entry, index) =>
    toMedicationDose(entry, index, usedIds)
  );
  sanitized.sort((left, right) =>
    compareTimes(left.scheduledTime, right.scheduledTime)
  );
  return sanitized;
};

const computeAdherenceSnapshot = (
  input: { schedule: MedicationDose[]; records: DoseRecord[] },
): AdherenceSnapshot => {
  const total = input.schedule.length;
  const taken = Math.min(input.records.length, total);
  const pending = Math.max(total - taken, 0);
  const percentage = total === 0
    ? 100
    : Math.round((taken / total) * 10000) / 100;
  return { total, taken, pending, percentage };
};

const computeUpcoming = (
  input: { schedule: MedicationDose[]; records: DoseRecord[] },
): MedicationDose[] => {
  if (input.schedule.length === 0) {
    return [];
  }
  const takenIds = new Set<string>();
  for (const record of input.records) {
    takenIds.add(record.id);
  }
  return input.schedule.filter((dose) => !takenIds.has(dose.id));
};

const markDoseTaken = handler(
  (
    event: MarkDoseEvent | undefined,
    context: {
      taken: Cell<DoseRecord[]>;
      history: Cell<string[]>;
      schedule: Cell<MedicationDose[]>;
    },
  ) => {
    const schedule = context.schedule.get() ?? [];
    const id = sanitizeDoseId(event?.doseId, "");
    if (id.length === 0) return;
    const dose = schedule.find((entry) => entry.id === id);
    if (!dose) return;

    const existing = context.taken.get();
    const log = context.history.get();
    const takenRecords = Array.isArray(existing) ? existing : [];
    if (takenRecords.some((record) => record.id === id)) {
      return;
    }

    const takenAt = sanitizeTime(event?.takenAt, dose.scheduledTime);
    const nextRecords = [...takenRecords, {
      id: dose.id,
      medication: dose.medication,
      scheduledTime: dose.scheduledTime,
      takenAt,
    }];
    nextRecords.sort((left, right) =>
      compareTimes(left.scheduledTime, right.scheduledTime)
    );
    context.taken.set(nextRecords);

    const message =
      `Took ${dose.medication} scheduled for ${dose.scheduledTime} at ${takenAt}`;
    const historyEntries = Array.isArray(log) ? log : [];
    context.history.set([...historyEntries, message]);
  },
);

const resetAdherence = handler(
  (
    _event: unknown,
    context: { taken: Cell<DoseRecord[]>; history: Cell<string[]> },
  ) => {
    context.taken.set([]);
    context.history.set([]);
  },
);

/** Medication adherence tracking pattern with UI. */
export const medicationAdherencePatternUx = recipe<MedicationAdherenceArgs>(
  "Medication Adherence Pattern (UX)",
  ({ doses }) => {
    const schedule = lift(sanitizeSchedule)(doses);
    const takenRecords = cell<DoseRecord[]>([]);
    const history = cell<string[]>([]);

    const adherence = lift((input: {
      schedule: MedicationDose[];
      records: DoseRecord[];
    }) => computeAdherenceSnapshot(input))({
      schedule,
      records: takenRecords,
    });

    const adherencePercentage = lift((snapshot: AdherenceSnapshot) =>
      snapshot.percentage
    )(adherence);
    const takenCount = lift((snapshot: AdherenceSnapshot) => snapshot.taken)(
      adherence,
    );
    const totalCount = lift((snapshot: AdherenceSnapshot) => snapshot.total)(
      adherence,
    );
    const remainingCount = lift((snapshot: AdherenceSnapshot) =>
      snapshot.pending
    )(adherence);

    const percentageLabel = str`${adherencePercentage}% adherence`;
    const adherenceLabel = str`${takenCount} of ${totalCount} doses taken`;
    const remainingLabel = lift((count: number) =>
      `${count} dose${count === 1 ? "" : "s"} remaining`
    )(remainingCount);

    const upcomingDoses = lift((input: {
      schedule: MedicationDose[];
      records: DoseRecord[];
    }) => computeUpcoming(input))({
      schedule,
      records: takenRecords,
    });

    // UI cells for form inputs
    const doseIdField = cell<string>("");
    const takenAtField = cell<string>("");

    // UI handler to mark a dose as taken
    const markDoseHandler = handler<
      unknown,
      {
        doseIdField: Cell<string>;
        takenAtField: Cell<string>;
        taken: Cell<DoseRecord[]>;
        history: Cell<string[]>;
        schedule: Cell<MedicationDose[]>;
      }
    >((_event, ctx) => {
      const schedule = ctx.schedule.get() ?? [];
      const id = sanitizeDoseId(ctx.doseIdField.get(), "");
      if (id.length === 0) return;
      const dose = schedule.find((entry) => entry.id === id);
      if (!dose) return;

      const existing = ctx.taken.get();
      const log = ctx.history.get();
      const takenRecords = Array.isArray(existing) ? existing : [];
      if (takenRecords.some((record) => record.id === id)) {
        return;
      }

      const takenAt = sanitizeTime(
        ctx.takenAtField.get(),
        dose.scheduledTime,
      );
      const nextRecords = [...takenRecords, {
        id: dose.id,
        medication: dose.medication,
        scheduledTime: dose.scheduledTime,
        takenAt,
      }];
      nextRecords.sort((left, right) =>
        compareTimes(left.scheduledTime, right.scheduledTime)
      );
      ctx.taken.set(nextRecords);

      const message =
        `Took ${dose.medication} scheduled for ${dose.scheduledTime} at ${takenAt}`;
      const historyEntries = Array.isArray(log) ? log : [];
      ctx.history.set([...historyEntries, message]);

      // Clear form fields
      ctx.doseIdField.set("");
      ctx.takenAtField.set("");
    })({
      doseIdField,
      takenAtField,
      taken: takenRecords,
      history,
      schedule,
    });

    const name = str`Medication Adherence (${adherencePercentage}%)`;

    const ui = (
      <div style="
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          max-width: 50rem;
          padding: 1rem;
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
                Medication adherence
              </span>
              <h2 style="
                  margin: 0;
                  font-size: 1.3rem;
                  color: #0f172a;
                ">
                Track your medication schedule
              </h2>
              <p style="
                  margin: 0;
                  font-size: 0.9rem;
                  color: #64748b;
                ">
                Monitor medication adherence by tracking doses taken against
                scheduled doses. Mark doses as taken and view your adherence
                percentage.
              </p>
            </div>

            <div style="
                background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
                border-radius: 0.75rem;
                padding: 1.5rem;
                display: flex;
                flex-direction: column;
                gap: 1rem;
                align-items: center;
              ">
              <span style="
                  font-size: 0.85rem;
                  color: rgba(255, 255, 255, 0.9);
                  font-weight: 500;
                ">
                Adherence rate
              </span>
              <strong style="
                  font-size: 3.5rem;
                  color: white;
                  font-weight: 700;
                  font-family: monospace;
                ">
                {adherencePercentage}%
              </strong>
              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 1rem;
                  width: 100%;
                  margin-top: 0.5rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 1.5rem;
                      color: white;
                      font-weight: 700;
                      font-family: monospace;
                    ">
                    {takenCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: rgba(255, 255, 255, 0.8);
                    ">
                    Taken
                  </span>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 1.5rem;
                      color: white;
                      font-weight: 700;
                      font-family: monospace;
                    ">
                    {totalCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: rgba(255, 255, 255, 0.8);
                    ">
                    Total
                  </span>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 1.5rem;
                      color: white;
                      font-weight: 700;
                      font-family: monospace;
                    ">
                    {remainingCount}
                  </span>
                  <span style="
                      font-size: 0.75rem;
                      color: rgba(255, 255, 255, 0.8);
                    ">
                    Remaining
                  </span>
                </div>
              </div>
            </div>
          </div>
        </ct-card>

        <ct-card>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 1rem;
            "
          >
            <h3 style="
                margin: 0;
                font-size: 1rem;
                color: #334155;
                font-weight: 600;
              ">
              Upcoming doses
            </h3>
            {lift((doses: MedicationDose[]) => {
              if (!Array.isArray(doses) || doses.length === 0) {
                return h(
                  "div",
                  {
                    style:
                      "padding: 2rem; text-align: center; color: #10b981; font-weight: 500; background: #d1fae5; border-radius: 0.5rem;",
                  },
                  "🎉 All doses completed!",
                );
              }

              const elements = [];
              for (let i = 0; i < doses.length; i++) {
                const dose = doses[i];
                const bgColor = i % 2 === 0 ? "#ffffff" : "#f8fafc";
                elements.push(
                  h(
                    "div",
                    {
                      style: "background: " + bgColor +
                        "; padding: 1rem; border-radius: 0.5rem; border: 1px solid #e2e8f0;",
                    },
                    h(
                      "div",
                      {
                        style:
                          "display: flex; flex-direction: column; gap: 0.75rem;",
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
                              "display: flex; flex-direction: column; gap: 0.25rem;",
                          },
                          h(
                            "div",
                            {
                              style:
                                "font-size: 1rem; font-weight: 600; color: #0f172a;",
                            },
                            dose.medication,
                          ),
                          h(
                            "div",
                            {
                              style: "font-size: 0.85rem; color: #64748b;",
                            },
                            dose.dosage,
                          ),
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 1.25rem; font-weight: 700; color: #0891b2; font-family: monospace; background: #cffafe; padding: 0.5rem 0.75rem; border-radius: 0.5rem;",
                          },
                          dose.scheduledTime,
                        ),
                      ),
                      h(
                        "div",
                        {
                          style:
                            "font-size: 0.85rem; color: #475569; font-style: italic;",
                        },
                        dose.instructions,
                      ),
                      h(
                        "div",
                        {
                          style:
                            "font-size: 0.75rem; color: #94a3b8; font-family: monospace;",
                        },
                        "ID: " + dose.id,
                      ),
                    ),
                  ),
                );
              }
              return h(
                "div",
                {
                  style: "display: flex; flex-direction: column; gap: 0.5rem;",
                },
                ...elements,
              );
            })(upcomingDoses)}
          </div>
        </ct-card>

        <ct-card>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 1rem;
            "
          >
            <h3 style="
                margin: 0;
                font-size: 1rem;
                color: #334155;
                font-weight: 600;
              ">
              Mark dose as taken
            </h3>
            <div style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              ">
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="dose-id"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Dose ID
                </label>
                <ct-input
                  id="dose-id"
                  type="text"
                  placeholder="Enter dose ID"
                  $value={doseIdField}
                  aria-label="Dose ID"
                >
                </ct-input>
              </div>
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="taken-at"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Time taken (optional, defaults to scheduled time)
                </label>
                <ct-input
                  id="taken-at"
                  type="text"
                  placeholder="HH:MM (e.g., 08:15)"
                  $value={takenAtField}
                  aria-label="Time taken"
                >
                </ct-input>
              </div>
              <ct-button onClick={markDoseHandler} aria-label="Mark dose taken">
                Mark as taken
              </ct-button>
            </div>
          </div>
        </ct-card>

        <ct-card>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 1rem;
            "
          >
            <h3 style="
                margin: 0;
                font-size: 1rem;
                color: #334155;
                font-weight: 600;
              ">
              Taken doses
            </h3>
            {lift((records: DoseRecord[]) => {
              if (!Array.isArray(records) || records.length === 0) {
                return h(
                  "div",
                  {
                    style:
                      "padding: 1.5rem; text-align: center; color: #64748b; background: #f1f5f9; border-radius: 0.5rem;",
                  },
                  "No doses recorded yet",
                );
              }

              const elements = [];
              for (let i = 0; i < records.length; i++) {
                const record = records[i];
                const bgColor = i % 2 === 0 ? "#ecfdf5" : "#d1fae5";
                elements.push(
                  h(
                    "div",
                    {
                      style: "background: " + bgColor +
                        "; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #10b981;",
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
                            "display: flex; flex-direction: column; gap: 0.25rem;",
                        },
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.95rem; font-weight: 600; color: #065f46;",
                          },
                          record.medication,
                        ),
                        h(
                          "div",
                          {
                            style: "font-size: 0.75rem; color: #047857;",
                          },
                          "Scheduled: " + record.scheduledTime,
                        ),
                      ),
                      h(
                        "div",
                        {
                          style:
                            "font-size: 1rem; font-weight: 700; color: #059669; font-family: monospace;",
                        },
                        "✓ " + record.takenAt,
                      ),
                    ),
                  ),
                );
              }
              return h(
                "div",
                {
                  style: "display: flex; flex-direction: column; gap: 0.5rem;",
                },
                ...elements,
              );
            })(takenRecords)}
          </div>
        </ct-card>

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
                justify-content: space-between;
                align-items: center;
              ">
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #334155;
                  font-weight: 600;
                ">
                Activity history
              </h3>
              <ct-button
                onClick={resetAdherence({ taken: takenRecords, history })}
                variant="secondary"
                aria-label="Reset all"
              >
                Reset all
              </ct-button>
            </div>
            {lift((log: string[]) => {
              if (!Array.isArray(log) || log.length === 0) {
                return h(
                  "div",
                  {
                    style:
                      "padding: 1.5rem; text-align: center; color: #64748b; background: #f1f5f9; border-radius: 0.5rem;",
                  },
                  "No activity yet",
                );
              }

              const reversed = log.slice().reverse();
              const elements = [];
              const displayCount = Math.min(reversed.length, 6);
              for (let i = 0; i < displayCount; i++) {
                const entry = reversed[i];
                elements.push(
                  h(
                    "div",
                    {
                      style:
                        "padding: 0.75rem; background: #f8fafc; border-left: 3px solid #0891b2; font-size: 0.85rem; color: #334155;",
                    },
                    entry,
                  ),
                );
              }
              return h(
                "div",
                {
                  style: "display: flex; flex-direction: column; gap: 0.5rem;",
                },
                ...elements,
              );
            })(history)}
          </div>
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      schedule,
      takenRecords,
      history,
      stats: adherence,
      adherencePercentage,
      percentageLabel,
      adherenceLabel,
      remainingLabel,
      upcomingDoses,
      markDose: markDoseTaken({
        taken: takenRecords,
        history,
        schedule,
      }),
      reset: resetAdherence({ taken: takenRecords, history }),
    };
  },
);

export default medicationAdherencePatternUx;
export type { AdherenceSnapshot, DoseRecord, MedicationDose };
