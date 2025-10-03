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

interface VitalThresholdsInput {
  heartRate?: { min?: number; max?: number };
  systolic?: { max?: number };
  diastolic?: { max?: number };
  temperature?: { min?: number; max?: number };
  oxygen?: { min?: number };
}

interface VitalThresholds {
  heartRate: { min: number; max: number };
  systolic: { max: number };
  diastolic: { max: number };
  temperature: { min: number; max: number };
  oxygen: { min: number };
}

interface VitalReadingSeed {
  id?: string;
  recordedAt?: string;
  heartRate?: number;
  systolic?: number;
  diastolic?: number;
  temperature?: number;
  oxygenSaturation?: number;
}

interface VitalReading {
  id: string;
  recordedAt: string;
  heartRate: number;
  systolic: number;
  diastolic: number;
  temperature: number;
  oxygenSaturation: number;
}

interface PatientVitalsArgs {
  patientName: Default<string, "Unknown patient">;
  initialReadings: Default<VitalReadingSeed[], []>;
  thresholds: Default<VitalThresholdsInput, {}>;
}

interface RecordReadingEvent extends VitalReadingSeed {}

interface UpdateThresholdsEvent extends VitalThresholdsInput {}

interface AlertSnapshot {
  readingId: string;
  alerts: string[];
}

const defaultThresholds = {
  heartRate: { min: 55, max: 110 },
  systolic: { max: 140 },
  diastolic: { max: 90 },
  temperature: { min: 36, max: 38 },
  oxygen: { min: 95 },
} as const satisfies VitalThresholds;

const isoMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

const toIsoMinute = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isoMinutePattern.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.toISOString().slice(0, 16)}Z`;
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.toISOString().slice(0, 16)}Z`;
  }
  return fallback;
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.trunc(fallback));
  }
  return Math.max(0, Math.trunc(value));
};

const toBpm = (value: unknown, fallback: number): number => {
  const sanitized = toPositiveInt(value, fallback);
  return Math.min(240, sanitized);
};

const toBloodPressure = (value: unknown, fallback: number): number => {
  const sanitized = toPositiveInt(value, fallback);
  return Math.min(250, sanitized);
};

const toTemperature = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.max(30, Math.min(45, value));
    return Math.round(normalized * 10) / 10;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(Math.max(30, Math.min(45, parsed)) * 10) / 10;
    }
  }
  return Math.round(fallback * 10) / 10;
};

const toOxygen = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(50, Math.min(100, Math.trunc(fallback)));
  }
  return Math.max(50, Math.min(100, Math.trunc(value)));
};

const sanitizeId = (
  value: unknown,
  fallback: string,
  used: Set<string>,
): string => {
  let base: string;
  if (typeof value === "string") {
    const trimmed = value.trim();
    base = trimmed.length > 0 ? trimmed : fallback;
  } else {
    base = fallback;
  }
  let id = base;
  let attempt = 1;
  while (used.has(id)) {
    attempt += 1;
    id = `${base}-${attempt}`;
  }
  used.add(id);
  return id;
};

const toFallbackTimestamp = (index: number): string => {
  const start = new Date(Date.UTC(2024, 0, 1, 8, 0, 0));
  start.setUTCMinutes(start.getUTCMinutes() + index * 90);
  return `${start.toISOString().slice(0, 16)}Z`;
};

const toVitalReading = (
  seed: VitalReadingSeed | undefined,
  index: number,
  usedIds: Set<string>,
): VitalReading => {
  const recordedAt = toIsoMinute(seed?.recordedAt, toFallbackTimestamp(index));
  const heartRate = toBpm(seed?.heartRate, 72);
  const systolic = toBloodPressure(seed?.systolic, 118);
  const diastolic = toBloodPressure(seed?.diastolic, 76);
  const temperature = toTemperature(seed?.temperature, 36.8);
  const oxygen = toOxygen(seed?.oxygenSaturation, 97);
  const id = sanitizeId(seed?.id, `reading-${index + 1}`, usedIds);
  return {
    id,
    recordedAt,
    heartRate,
    systolic,
    diastolic,
    temperature,
    oxygenSaturation: oxygen,
  };
};

const sanitizeReadings = (
  entries: readonly VitalReadingSeed[] | undefined,
): VitalReading[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const used = new Set<string>();
  const sanitized = entries.map((entry, index) =>
    toVitalReading(entry, index, used)
  );
  sanitized.sort((left, right) => {
    if (left.recordedAt === right.recordedAt) {
      return left.id.localeCompare(right.id);
    }
    return left.recordedAt.localeCompare(right.recordedAt);
  });
  return sanitized;
};

const sanitizeThresholds = (
  seed: VitalThresholdsInput | undefined,
  fallback: VitalThresholds,
): VitalThresholds => {
  const heartMin = toBpm(seed?.heartRate?.min, fallback.heartRate.min);
  const heartMax = toBpm(seed?.heartRate?.max, fallback.heartRate.max);
  const systolicMax = toBloodPressure(
    seed?.systolic?.max,
    fallback.systolic.max,
  );
  const diastolicMax = toBloodPressure(
    seed?.diastolic?.max,
    fallback.diastolic.max,
  );
  const tempMin = toTemperature(
    seed?.temperature?.min,
    fallback.temperature.min,
  );
  const tempMax = toTemperature(
    seed?.temperature?.max,
    fallback.temperature.max,
  );
  const oxygenMin = toOxygen(seed?.oxygen?.min, fallback.oxygen.min);

  const heartRate = heartMin <= heartMax
    ? { min: heartMin, max: heartMax }
    : { min: heartMax, max: heartMin };
  const temperature = tempMin <= tempMax
    ? { min: tempMin, max: tempMax }
    : { min: tempMax, max: tempMin };

  return {
    heartRate,
    systolic: { max: systolicMax },
    diastolic: { max: diastolicMax },
    temperature,
    oxygen: { min: oxygenMin },
  };
};

const summarizeReading = (reading: VitalReading): string => {
  const bp = `${reading.systolic}/${reading.diastolic}`;
  return `${reading.recordedAt} · HR ${reading.heartRate} bpm · BP ${bp} mmHg · ` +
    `Temp ${
      reading.temperature.toFixed(1)
    }°C · SpO₂ ${reading.oxygenSaturation}%`;
};

const computeAlerts = (
  reading: VitalReading | null,
  thresholds: VitalThresholds,
): string[] => {
  if (!reading) {
    return [];
  }
  const alerts: string[] = [];
  if (reading.heartRate < thresholds.heartRate.min) {
    alerts.push(
      `Heart rate low: ${reading.heartRate} bpm (min ` +
        `${thresholds.heartRate.min})`,
    );
  } else if (reading.heartRate > thresholds.heartRate.max) {
    alerts.push(
      `Heart rate high: ${reading.heartRate} bpm (max ` +
        `${thresholds.heartRate.max})`,
    );
  }
  if (
    reading.systolic > thresholds.systolic.max ||
    reading.diastolic > thresholds.diastolic.max
  ) {
    alerts.push(
      `Blood pressure high: ${reading.systolic}/${reading.diastolic} mmHg (` +
        `max ${thresholds.systolic.max}/${thresholds.diastolic.max})`,
    );
  }
  if (reading.temperature < thresholds.temperature.min) {
    alerts.push(
      `Temperature low: ${reading.temperature.toFixed(1)}°C (min ` +
        `${thresholds.temperature.min.toFixed(1)}°C)`,
    );
  } else if (reading.temperature > thresholds.temperature.max) {
    alerts.push(
      `Temperature high: ${reading.temperature.toFixed(1)}°C (max ` +
        `${thresholds.temperature.max.toFixed(1)}°C)`,
    );
  }
  if (reading.oxygenSaturation < thresholds.oxygen.min) {
    alerts.push(
      `Oxygen saturation low: ${reading.oxygenSaturation}% (min ` +
        `${thresholds.oxygen.min}%)`,
    );
  }
  return alerts;
};

const buildAlertHistory = (
  readings: readonly VitalReading[],
  thresholds: VitalThresholds,
): AlertSnapshot[] => {
  return readings.map((reading) => ({
    readingId: reading.id,
    alerts: computeAlerts(reading, thresholds),
  }));
};

const buildHistorySummaries = (
  readings: readonly VitalReading[],
): string[] => {
  return readings.map(summarizeReading);
};

const recordVitalReading = handler(
  (
    event: RecordReadingEvent | undefined,
    context: {
      state: Cell<VitalReading[]>;
      combined: Cell<VitalReading[]>;
      thresholds: Cell<VitalThresholds>;
    },
  ) => {
    const existing = context.combined.get() ?? [];
    const used = new Set(existing.map((entry) => entry.id));
    const reading = toVitalReading(event, existing.length, used);
    const nextHistory = [...existing.slice(-11), reading];
    context.state.set(nextHistory);
  },
);

const updateThresholds = handler(
  (
    event: UpdateThresholdsEvent | undefined,
    context: { thresholds: Cell<VitalThresholdsInput> },
  ) => {
    const current = sanitizeThresholds(
      context.thresholds.get(),
      defaultThresholds,
    );
    const next = sanitizeThresholds(event, current);
    context.thresholds.set(next as VitalThresholdsInput);
  },
);

/** Pattern tracking patient vitals with derived alert summaries. */
export const patientVitalsDashboardPattern = recipe<PatientVitalsArgs>(
  "Patient Vitals Dashboard",
  ({ patientName, initialReadings, thresholds }) => {
    const readableName = lift((value: string | undefined) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
      return "Unknown patient";
    })(patientName);

    const history = cell<VitalReading[]>([]);
    const historySeed = lift((seed: VitalReadingSeed[] | undefined) =>
      sanitizeReadings(seed)
    )(initialReadings);
    const historyView = lift(
      (
        input: { state: VitalReading[]; seed: VitalReading[] },
      ): VitalReading[] => {
        const stateEntries = Array.isArray(input.state) ? input.state : [];
        return stateEntries.length > 0 ? stateEntries : input.seed;
      },
    )({ state: history, seed: historySeed });
    const summariesView = lift((entries: VitalReading[]) =>
      buildHistorySummaries(entries)
    )(historyView);
    const thresholdsView = lift((seed: VitalThresholdsInput | undefined) =>
      sanitizeThresholds(seed, defaultThresholds)
    )(thresholds);

    const latestReading = lift((entries: VitalReading[]) => {
      return entries.length === 0 ? null : entries[entries.length - 1];
    })(historyView);

    const alerts = lift(
      (
        input: {
          reading: VitalReading | null;
          thresholds: VitalThresholds;
        },
      ) => computeAlerts(input.reading, input.thresholds),
    )({ reading: latestReading, thresholds: thresholdsView });

    const alertHistory = lift(
      (
        input: {
          readings: VitalReading[];
          thresholds: VitalThresholds;
        },
      ) => buildAlertHistory(input.readings, input.thresholds),
    )({ readings: historyView, thresholds: thresholdsView });

    const alertCount = lift((list: string[] | undefined) =>
      Array.isArray(list) ? list.length : 0
    )(alerts);
    const critical = lift((count: number) => count > 0)(alertCount);

    const latestSummaryText = lift((reading: VitalReading | null) =>
      reading ? summarizeReading(reading) : "No readings yet"
    )(latestReading);
    const alertSummaryText = lift((count: number) =>
      count === 0 ? "All vitals within range" : `${count} active alerts`
    )(alertCount);

    const statusLabel = str`${readableName} · Alerts: ${alertCount}`;
    const latestSummary = str`Latest: ${latestSummaryText}`;
    const alertLabel = str`Alerts: ${alertSummaryText}`;

    // UI-specific state
    const heartRateField = cell<string>("");
    const systolicField = cell<string>("");
    const diastolicField = cell<string>("");
    const temperatureField = cell<string>("");
    const oxygenField = cell<string>("");
    const timestampField = cell<string>("");

    const hrMinField = cell<string>("");
    const hrMaxField = cell<string>("");
    const sysMaxField = cell<string>("");
    const diaMaxField = cell<string>("");
    const tempMinField = cell<string>("");
    const tempMaxField = cell<string>("");
    const o2MinField = cell<string>("");

    // UI handler for recording vitals
    const recordVitalsUI = handler(
      (
        _event: unknown,
        context: {
          hrField: Cell<string>;
          sysField: Cell<string>;
          diaField: Cell<string>;
          tempField: Cell<string>;
          o2Field: Cell<string>;
          tsField: Cell<string>;
          state: Cell<VitalReading[]>;
          combined: Cell<VitalReading[]>;
        },
      ) => {
        const hrStr = context.hrField.get();
        const sysStr = context.sysField.get();
        const diaStr = context.diaField.get();
        const tempStr = context.tempField.get();
        const o2Str = context.o2Field.get();
        const tsStr = context.tsField.get();

        const hr = typeof hrStr === "string" && hrStr.trim() !== ""
          ? Number(hrStr)
          : undefined;
        const sys = typeof sysStr === "string" && sysStr.trim() !== ""
          ? Number(sysStr)
          : undefined;
        const dia = typeof diaStr === "string" && diaStr.trim() !== ""
          ? Number(diaStr)
          : undefined;
        const temp = typeof tempStr === "string" && tempStr.trim() !== ""
          ? Number(tempStr)
          : undefined;
        const o2 = typeof o2Str === "string" && o2Str.trim() !== ""
          ? Number(o2Str)
          : undefined;
        const ts = typeof tsStr === "string" && tsStr.trim() !== ""
          ? tsStr
          : undefined;

        const existing = context.combined.get() ?? [];
        const used = new Set(existing.map((entry) => entry.id));
        const reading = toVitalReading(
          {
            heartRate: hr,
            systolic: sys,
            diastolic: dia,
            temperature: temp,
            oxygenSaturation: o2,
            recordedAt: ts,
          },
          existing.length,
          used,
        );
        const nextHistory = [...existing.slice(-11), reading];
        context.state.set(nextHistory);

        context.hrField.set("");
        context.sysField.set("");
        context.diaField.set("");
        context.tempField.set("");
        context.o2Field.set("");
        context.tsField.set("");
      },
    );

    // UI handler for updating thresholds
    const updateThresholdsUI = handler(
      (
        _event: unknown,
        context: {
          hrMinField: Cell<string>;
          hrMaxField: Cell<string>;
          sysMaxField: Cell<string>;
          diaMaxField: Cell<string>;
          tempMinField: Cell<string>;
          tempMaxField: Cell<string>;
          o2MinField: Cell<string>;
          thresholds: Cell<VitalThresholdsInput>;
        },
      ) => {
        const hrMin = context.hrMinField.get();
        const hrMax = context.hrMaxField.get();
        const sysMax = context.sysMaxField.get();
        const diaMax = context.diaMaxField.get();
        const tempMin = context.tempMinField.get();
        const tempMax = context.tempMaxField.get();
        const o2Min = context.o2MinField.get();

        const current = sanitizeThresholds(
          context.thresholds.get(),
          defaultThresholds,
        );

        const event: UpdateThresholdsEvent = {};
        if (typeof hrMin === "string" && hrMin.trim() !== "") {
          event.heartRate = event.heartRate || {};
          event.heartRate.min = Number(hrMin);
        }
        if (typeof hrMax === "string" && hrMax.trim() !== "") {
          event.heartRate = event.heartRate || {};
          event.heartRate.max = Number(hrMax);
        }
        if (typeof sysMax === "string" && sysMax.trim() !== "") {
          event.systolic = { max: Number(sysMax) };
        }
        if (typeof diaMax === "string" && diaMax.trim() !== "") {
          event.diastolic = { max: Number(diaMax) };
        }
        if (typeof tempMin === "string" && tempMin.trim() !== "") {
          event.temperature = event.temperature || {};
          event.temperature.min = Number(tempMin);
        }
        if (typeof tempMax === "string" && tempMax.trim() !== "") {
          event.temperature = event.temperature || {};
          event.temperature.max = Number(tempMax);
        }
        if (typeof o2Min === "string" && o2Min.trim() !== "") {
          event.oxygen = { min: Number(o2Min) };
        }

        const next = sanitizeThresholds(event, current);
        context.thresholds.set(next as VitalThresholdsInput);

        context.hrMinField.set("");
        context.hrMaxField.set("");
        context.sysMaxField.set("");
        context.diaMaxField.set("");
        context.tempMinField.set("");
        context.tempMaxField.set("");
        context.o2MinField.set("");
      },
    );

    const name = str`${readableName} Vitals`;

    const headerSection = lift(
      (input: { patientName: string; alertCount: number }) => {
        const headerBg = input.alertCount > 0
          ? "background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);"
          : "background: linear-gradient(135deg, #059669 0%, #047857 100%);";

        const statusText = input.alertCount > 0
          ? String(input.alertCount) + " CRITICAL ALERTS"
          : "ALL VITALS NORMAL";

        return h(
          "div",
          {
            style: headerBg +
              " color: white; padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem;",
          },
          h(
            "h1",
            { style: "margin: 0; font-size: 1.75rem; font-weight: 700;" },
            input.patientName + " - Vital Signs Monitor",
          ),
          h(
            "div",
            {
              style:
                "margin-top: 0.75rem; font-size: 1.125rem; font-weight: 600; letter-spacing: 0.05em;",
            },
            statusText,
          ),
        );
      },
    )({ patientName: readableName, alertCount });

    const latestReadingSection = lift((latest: VitalReading | null) => {
      const latestDisplay = latest
        ? h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; margin-top: 1rem;",
          },
          h(
            "div",
            {
              style:
                "background: #f0f9ff; border: 2px solid #0284c7; border-radius: 8px; padding: 1rem;",
            },
            h(
              "div",
              {
                style: "font-size: 0.75rem; color: #0369a1; font-weight: 600;",
              },
              "HEART RATE",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 2rem; font-weight: 700; color: #0c4a6e; font-family: monospace;",
              },
              String(latest.heartRate) + " bpm",
            ),
          ),
          h(
            "div",
            {
              style:
                "background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 1rem;",
            },
            h(
              "div",
              {
                style: "font-size: 0.75rem; color: #d97706; font-weight: 600;",
              },
              "BLOOD PRESSURE",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 2rem; font-weight: 700; color: #92400e; font-family: monospace;",
              },
              String(latest.systolic) + "/" + String(latest.diastolic),
            ),
            h(
              "div",
              { style: "font-size: 0.875rem; color: #78350f;" },
              "mmHg",
            ),
          ),
          h(
            "div",
            {
              style:
                "background: #fce7f3; border: 2px solid #ec4899; border-radius: 8px; padding: 1rem;",
            },
            h(
              "div",
              {
                style: "font-size: 0.75rem; color: #db2777; font-weight: 600;",
              },
              "TEMPERATURE",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 2rem; font-weight: 700; color: #831843; font-family: monospace;",
              },
              latest.temperature.toFixed(1) + "°C",
            ),
          ),
          h(
            "div",
            {
              style:
                "background: #f0fdf4; border: 2px solid #22c55e; border-radius: 8px; padding: 1rem;",
            },
            h(
              "div",
              {
                style: "font-size: 0.75rem; color: #16a34a; font-weight: 600;",
              },
              "OXYGEN (SpO₂)",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 2rem; font-weight: 700; color: #14532d; font-family: monospace;",
              },
              String(latest.oxygenSaturation) + "%",
            ),
          ),
        )
        : h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #6b7280; font-style: italic;",
          },
          "No readings recorded yet",
        );

      return h(
        "div",
        {
          style:
            "background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
          },
          "Latest Reading",
        ),
        latestDisplay,
      );
    })(latestReading);

    const alertsSection = lift(
      (input: { alerts: string[]; thresholds: VitalThresholds }) => {
        const alertsList = input.alerts.length > 0
          ? (() => {
            const elements = [];
            for (const alert of input.alerts) {
              elements.push(
                h(
                  "div",
                  {
                    style:
                      "background: #fee; border-left: 4px solid #dc2626; padding: 0.75rem; margin-bottom: 0.5rem; border-radius: 4px;",
                  },
                  h(
                    "span",
                    { style: "font-weight: 600; color: #991b1b;" },
                    "⚠ ",
                  ),
                  alert,
                ),
              );
            }
            return h("div", {}, ...elements);
          })()
          : h(
            "div",
            {
              style:
                "padding: 1rem; text-align: center; background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; color: #15803d;",
            },
            "✓ All vitals within normal range",
          );

        const thresholdDisplay = h(
          "div",
          {
            style:
              "background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 8px; padding: 1rem; margin-top: 1.5rem;",
          },
          h(
            "div",
            {
              style:
                "font-weight: 700; margin-bottom: 0.75rem; color: #374151;",
            },
            "Current Thresholds",
          ),
          h(
            "div",
            {
              style:
                "display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; font-size: 0.875rem;",
            },
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #6b7280;" },
                "Heart Rate: ",
              ),
              String(input.thresholds.heartRate.min) + "-" +
                String(input.thresholds.heartRate.max) + " bpm",
            ),
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #6b7280;" },
                "Systolic: ",
              ),
              "≤" + String(input.thresholds.systolic.max) + " mmHg",
            ),
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #6b7280;" },
                "Diastolic: ",
              ),
              "≤" + String(input.thresholds.diastolic.max) + " mmHg",
            ),
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #6b7280;" },
                "Temperature: ",
              ),
              String(input.thresholds.temperature.min) + "-" +
                String(input.thresholds.temperature.max) + "°C",
            ),
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #6b7280;" },
                "Oxygen: ",
              ),
              "≥" + String(input.thresholds.oxygen.min) + "%",
            ),
          ),
        );

        return h(
          "div",
          {
            style:
              "background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;",
          },
          h(
            "h2",
            {
              style:
                "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
            },
            "Active Alerts",
          ),
          alertsList,
          thresholdDisplay,
        );
      },
    )({ alerts, thresholds: thresholdsView });

    const historySection = lift((readings: VitalReading[]) => {
      const historyElements = [];
      const recentReadings = readings.slice(-5).reverse();
      for (let i = 0; i < recentReadings.length; i++) {
        const reading = recentReadings[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f9fafb";
        historyElements.push(
          h(
            "div",
            {
              style: "padding: 0.75rem; background: " + bgColor +
                "; border-bottom: 1px solid #e5e7eb; font-size: 0.875rem; font-family: monospace;",
            },
            h(
              "div",
              {
                style:
                  "font-weight: 600; color: #1f2937; margin-bottom: 0.25rem;",
              },
              reading.recordedAt,
            ),
            h(
              "div",
              { style: "color: #6b7280;" },
              "HR: " + String(reading.heartRate) + " | BP: " +
                String(reading.systolic) + "/" + String(reading.diastolic) +
                " | Temp: " + reading.temperature.toFixed(1) + "°C | SpO₂: " +
                String(reading.oxygenSaturation) + "%",
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
          },
          "Recent History",
        ),
        historyElements.length > 0 ? h("div", {}, ...historyElements) : h(
          "div",
          {
            style:
              "padding: 1rem; text-align: center; color: #9ca3af; font-style: italic;",
          },
          "No readings yet",
        ),
      );
    })(historyView);

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 1rem;">
        {headerSection}
        {latestReadingSection}
        {alertsSection}
        {historySection}
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;">
            Record New Reading
          </h2>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Heart Rate (bpm)
              </label>
              <ct-input
                $value={heartRateField}
                placeholder="e.g. 75"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Systolic BP (mmHg)
              </label>
              <ct-input
                $value={systolicField}
                placeholder="e.g. 120"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Diastolic BP (mmHg)
              </label>
              <ct-input
                $value={diastolicField}
                placeholder="e.g. 80"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Temperature (°C)
              </label>
              <ct-input
                $value={temperatureField}
                placeholder="e.g. 36.8"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Oxygen Saturation (%)
              </label>
              <ct-input
                $value={oxygenField}
                placeholder="e.g. 98"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Timestamp (optional)
              </label>
              <ct-input
                $value={timestampField}
                placeholder="2024-07-15T14:30Z"
                style="width: 100%;"
              />
            </div>
          </div>
          <ct-button
            onClick={recordVitalsUI({
              hrField: heartRateField,
              sysField: systolicField,
              diaField: diastolicField,
              tempField: temperatureField,
              o2Field: oxygenField,
              tsField: timestampField,
              state: history,
              combined: historyView,
            })}
            style="margin-top: 1rem; background: #2563eb; color: white; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600;"
          >
            Record Vitals
          </ct-button>
        </div>
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;">
            Update Thresholds
          </h2>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                HR Min (bpm)
              </label>
              <ct-input
                $value={hrMinField}
                placeholder="55"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                HR Max (bpm)
              </label>
              <ct-input
                $value={hrMaxField}
                placeholder="110"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Systolic Max (mmHg)
              </label>
              <ct-input
                $value={sysMaxField}
                placeholder="140"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Diastolic Max (mmHg)
              </label>
              <ct-input
                $value={diaMaxField}
                placeholder="90"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Temp Min (°C)
              </label>
              <ct-input
                $value={tempMinField}
                placeholder="36"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                Temp Max (°C)
              </label>
              <ct-input
                $value={tempMaxField}
                placeholder="38"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 600; color: #374151; margin-bottom: 0.25rem;">
                O₂ Min (%)
              </label>
              <ct-input
                $value={o2MinField}
                placeholder="95"
                style="width: 100%;"
              />
            </div>
          </div>
          <ct-button
            onClick={updateThresholdsUI({
              hrMinField,
              hrMaxField,
              sysMaxField,
              diaMaxField,
              tempMinField,
              tempMaxField,
              o2MinField,
              thresholds,
            })}
            style="margin-top: 1rem; background: #7c3aed; color: white; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600;"
          >
            Update Thresholds
          </ct-button>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      patientName: readableName,
      thresholds: thresholdsView,
      readings: historyView,
      historySummaries: summariesView,
      alertHistory,
      alerts,
      alertCount,
      isCritical: critical,
      statusLabel,
      latestSummary,
      alertLabel,
      recordReading: recordVitalReading({
        state: history,
        combined: historyView,
        thresholds: thresholdsView,
      }),
      updateThresholds: updateThresholds({ thresholds }),
    };
  },
);
