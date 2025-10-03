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
  toSchema,
  UI,
} from "commontools";

interface DerivedDifferenceArgs {
  primary: Default<number, 0>;
  secondary: Default<number, 0>;
  primaryStep: Default<number, 1>;
  secondaryStep: Default<number, 1>;
}

type AdjustmentDirection = "increase" | "decrease";
type DifferenceSource = "primary" | "secondary";

interface AdjustmentEvent {
  amount?: number;
  direction?: AdjustmentDirection;
}

interface DifferenceAudit {
  sequence: number;
  via: DifferenceSource;
  primary: number;
  secondary: number;
  difference: number;
}

const sanitizeInteger = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const sanitizeStep = (value: unknown, fallback: number): number => {
  const raw = sanitizeInteger(value, fallback);
  const normalized = Math.abs(raw);
  if (normalized === 0) {
    return Math.abs(fallback) || 1;
  }
  return normalized;
};

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return String(sanitizeInteger(safe, 0));
};

const formatSource = (source: DifferenceSource): string => {
  return source === "primary" ? "Primary" : "Secondary";
};

const describeAuditLog = (entries: DifferenceAudit[]) => {
  if (entries.length === 0) {
    return [
      {
        id: "empty",
        title: "No adjustments yet",
        detail: "Use the controls to adjust either value.",
        badge: "",
      },
    ];
  }
  return entries
    .slice(-6)
    .reverse()
    .map((record) => {
      const sign = record.difference >= 0 ? "+" : "";
      return {
        id: "audit-" + String(record.sequence),
        title: formatSource(record.via) + " adjusted (#" +
          String(record.sequence) + ")",
        detail: "Primary " + String(record.primary) + " − Secondary " +
          String(record.secondary),
        badge: sign + String(record.difference),
      };
    });
};

export const counterWithDerivedDifferenceUx = recipe<DerivedDifferenceArgs>(
  "Counter With Derived Difference (UX)",
  ({ primary, secondary, primaryStep, secondaryStep }) => {
    const sequence = cell(0);
    const differenceHistory = cell<number[]>([]);
    const auditLog = cell<DifferenceAudit[]>([]);

    const primaryValue = lift((value: number | undefined) =>
      sanitizeInteger(value, 0)
    )(primary);
    const secondaryValue = lift((value: number | undefined) =>
      sanitizeInteger(value, 0)
    )(secondary);

    const primaryStepValue = lift((value: number | undefined) =>
      sanitizeStep(value, 1)
    )(primaryStep);
    const secondaryStepValue = lift((value: number | undefined) =>
      sanitizeStep(value, 1)
    )(secondaryStep);

    const differenceSummary = lift(
      toSchema<{ primary: Cell<number>; secondary: Cell<number> }>(),
      toSchema<{ primary: number; secondary: number; difference: number }>(),
      ({ primary, secondary }) => {
        const primaryValue = sanitizeInteger(primary.get(), 0);
        const secondaryValue = sanitizeInteger(secondary.get(), 0);
        return {
          primary: primaryValue,
          secondary: secondaryValue,
          difference: primaryValue - secondaryValue,
        };
      },
    )({
      primary: primaryValue,
      secondary: secondaryValue,
    });

    const differenceValue = derive(
      differenceSummary,
      (snapshot) => snapshot.difference,
    );

    const primaryDisplay = derive(primaryValue, (value) => formatNumber(value));
    const secondaryDisplay = derive(
      secondaryValue,
      (value) => formatNumber(value),
    );
    const differenceDisplay = derive(
      differenceValue,
      (value) => {
        const sign = value >= 0 ? "+" : "";
        return sign + formatNumber(value);
      },
    );
    const primaryStepDisplay = derive(
      primaryStepValue,
      (value) => formatNumber(value),
    );
    const secondaryStepDisplay = derive(
      secondaryStepValue,
      (value) => formatNumber(value),
    );

    const sequenceDisplay = derive(
      sequence,
      (count) => formatNumber(sanitizeInteger(count, 0)),
    );

    const auditLogView = lift((entries: DifferenceAudit[] | undefined) => {
      if (!Array.isArray(entries)) return [];
      return entries.map((entry) => ({
        sequence: sanitizeInteger(entry?.sequence, 0),
        via: entry?.via || "primary",
        primary: sanitizeInteger(entry?.primary, 0),
        secondary: sanitizeInteger(entry?.secondary, 0),
        difference: sanitizeInteger(entry?.difference, 0),
      }));
    })(auditLog);

    const auditCards = lift(
      (entries: DifferenceAudit[]) => {
        const items = describeAuditLog(entries);
        return items.map((item) => {
          const badgeColor = item.badge.startsWith("+") ||
              item.badge.startsWith("0")
            ? "#3b82f6"
            : "#ef4444";
          const badgeBgColor = item.badge.startsWith("+") ||
              item.badge.startsWith("0")
            ? "#eff6ff"
            : "#fee";
          return (
            <div
              key={item.id}
              style="
                border: 1px solid #e2e8f0;
                border-radius: 0.75rem;
                padding: 0.75rem;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                  flex: 1;
                ">
                <strong style="font-size: 0.95rem; color: #0f172a;">
                  {item.title}
                </strong>
                <span style="font-size: 0.8rem; color: #475569;">
                  {item.detail}
                </span>
              </div>
              {item.badge && (
                <span
                  style={"font-family: monospace; font-size: 0.9rem; font-weight: 600; color: " +
                    badgeColor +
                    "; background: " +
                    badgeBgColor +
                    "; padding: 0.25rem 0.5rem; border-radius: 0.5rem; white-space: nowrap;"}
                >
                  {item.badge}
                </span>
              )}
            </div>
          );
        });
      },
    )(auditLogView);

    const recordDifference = (
      state: {
        sequence: Cell<number>;
        log: Cell<DifferenceAudit[]>;
        history: Cell<number[]>;
        primary: Cell<number>;
        secondary: Cell<number>;
      },
      via: DifferenceSource,
    ): void => {
      const nextSequence = sanitizeInteger(state.sequence.get(), 0) + 1;
      state.sequence.set(nextSequence);
      const primaryValue = sanitizeInteger(state.primary.get(), 0);
      const secondaryValue = sanitizeInteger(state.secondary.get(), 0);
      const difference = primaryValue - secondaryValue;
      const entry: DifferenceAudit = {
        sequence: nextSequence,
        via,
        primary: primaryValue,
        secondary: secondaryValue,
        difference,
      };
      state.log.push(entry);
      state.history.push(difference);
    };

    const adjustPrimary = handler<
      unknown,
      {
        primary: Cell<number>;
        primaryStep: Cell<number>;
        secondary: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
        delta: number;
      }
    >((
      _event,
      {
        primary,
        primaryStep,
        secondary,
        sequence,
        auditLog,
        differenceHistory,
        delta,
      },
    ) => {
      const current = sanitizeInteger(primary.get(), 0);
      primary.set(current + delta);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "primary",
      );
    })({
      primary,
      primaryStep,
      secondary,
      sequence,
      auditLog,
      differenceHistory,
      delta: 0,
    });

    const adjustSecondary = handler<
      unknown,
      {
        primary: Cell<number>;
        secondary: Cell<number>;
        secondaryStep: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
        delta: number;
      }
    >((
      _event,
      {
        primary,
        secondary,
        secondaryStep,
        sequence,
        auditLog,
        differenceHistory,
        delta,
      },
    ) => {
      const current = sanitizeInteger(secondary.get(), 0);
      secondary.set(current + delta);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "secondary",
      );
    })({
      primary,
      secondary,
      secondaryStep,
      sequence,
      auditLog,
      differenceHistory,
      delta: 0,
    });

    const increasePrimary = handler<
      unknown,
      {
        primary: Cell<number>;
        primaryStep: Cell<number>;
        secondary: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
      }
    >((
      _event,
      {
        primary,
        primaryStep,
        secondary,
        sequence,
        auditLog,
        differenceHistory,
      },
    ) => {
      const current = sanitizeInteger(primary.get(), 0);
      const step = sanitizeStep(primaryStep.get(), 1);
      primary.set(current + step);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "primary",
      );
    })({
      primary,
      primaryStep,
      secondary,
      sequence,
      auditLog,
      differenceHistory,
    });

    const decreasePrimary = handler<
      unknown,
      {
        primary: Cell<number>;
        primaryStep: Cell<number>;
        secondary: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
      }
    >((
      _event,
      {
        primary,
        primaryStep,
        secondary,
        sequence,
        auditLog,
        differenceHistory,
      },
    ) => {
      const current = sanitizeInteger(primary.get(), 0);
      const step = sanitizeStep(primaryStep.get(), 1);
      primary.set(current - step);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "primary",
      );
    })({
      primary,
      primaryStep,
      secondary,
      sequence,
      auditLog,
      differenceHistory,
    });

    const increaseSecondary = handler<
      unknown,
      {
        primary: Cell<number>;
        secondary: Cell<number>;
        secondaryStep: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
      }
    >((
      _event,
      {
        primary,
        secondary,
        secondaryStep,
        sequence,
        auditLog,
        differenceHistory,
      },
    ) => {
      const current = sanitizeInteger(secondary.get(), 0);
      const step = sanitizeStep(secondaryStep.get(), 1);
      secondary.set(current + step);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "secondary",
      );
    })({
      primary,
      secondary,
      secondaryStep,
      sequence,
      auditLog,
      differenceHistory,
    });

    const decreaseSecondary = handler<
      unknown,
      {
        primary: Cell<number>;
        secondary: Cell<number>;
        secondaryStep: Cell<number>;
        sequence: Cell<number>;
        auditLog: Cell<DifferenceAudit[]>;
        differenceHistory: Cell<number[]>;
      }
    >((
      _event,
      {
        primary,
        secondary,
        secondaryStep,
        sequence,
        auditLog,
        differenceHistory,
      },
    ) => {
      const current = sanitizeInteger(secondary.get(), 0);
      const step = sanitizeStep(secondaryStep.get(), 1);
      secondary.set(current - step);
      recordDifference(
        {
          sequence,
          log: auditLog,
          history: differenceHistory,
          primary,
          secondary,
        },
        "secondary",
      );
    })({
      primary,
      secondary,
      secondaryStep,
      sequence,
      auditLog,
      differenceHistory,
    });

    const primaryStepField = cell<string>("1");
    const secondaryStepField = cell<string>("1");

    const primaryStepCandidate = derive(primaryStepField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return sanitizeStep(parsed, 1);
    });

    const secondaryStepCandidate = derive(secondaryStepField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return sanitizeStep(parsed, 1);
    });

    const updatePrimaryStep = handler<
      unknown,
      {
        primaryStep: Cell<number>;
        candidate: Cell<number>;
      }
    >((_event, { primaryStep, candidate }) => {
      const sanitized = sanitizeStep(candidate.get(), 1);
      primaryStep.set(sanitized);
    })({ primaryStep, candidate: primaryStepCandidate });

    const updateSecondaryStep = handler<
      unknown,
      {
        secondaryStep: Cell<number>;
        candidate: Cell<number>;
      }
    >((_event, { secondaryStep, candidate }) => {
      const sanitized = sanitizeStep(candidate.get(), 1);
      secondaryStep.set(sanitized);
    })({ secondaryStep, candidate: secondaryStepCandidate });

    const name = str`Derived difference counter (${differenceDisplay})`;
    const summaryLabel =
      str`Difference ${differenceValue} (primary ${primaryValue}, secondary ${secondaryValue})`;
    const status =
      str`Primary ${primaryDisplay} • Secondary ${secondaryDisplay} • Difference ${differenceDisplay} • ${sequenceDisplay} adjustments`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 42rem;
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
                  Derived difference pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track the computed difference between two counters
                </h2>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 0.75rem;
                ">
                <div style="
                    background: #dbeafe;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #1e40af;">
                    Primary value
                  </span>
                  <strong
                    data-testid="primary-value"
                    style="font-size: 1.5rem; color: #1e3a8a;"
                  >
                    {primaryDisplay}
                  </strong>
                </div>
                <div style="
                    background: #fce7f3;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #be185d;">
                    Secondary value
                  </span>
                  <strong
                    data-testid="secondary-value"
                    style="font-size: 1.5rem; color: #9f1239;"
                  >
                    {secondaryDisplay}
                  </strong>
                </div>
                <div style="
                    background: #f0fdf4;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #15803d;">
                    Difference
                  </span>
                  <strong
                    data-testid="difference"
                    style="font-size: 1.5rem; color: #14532d;"
                  >
                    {differenceDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 1.25rem;
                ">
                <div style="
                    border: 2px solid #dbeafe;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                  ">
                  <h3 style="
                      margin: 0;
                      font-size: 1rem;
                      font-weight: 600;
                      color: #1e3a8a;
                    ">
                    Primary counter
                  </h3>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      flex-wrap: wrap;
                    ">
                    <ct-button onClick={increasePrimary}>
                      + {primaryStepDisplay}
                    </ct-button>
                    <ct-button variant="secondary" onClick={decreasePrimary}>
                      − {primaryStepDisplay}
                    </ct-button>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="primary-step"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Step size
                    </label>
                    <ct-input
                      id="primary-step"
                      type="number"
                      min="1"
                      step="1"
                      $value={primaryStepField}
                      aria-label="Primary step size"
                    >
                    </ct-input>
                    <ct-button onClick={updatePrimaryStep}>
                      Update to {primaryStepCandidate}
                    </ct-button>
                  </div>
                </div>

                <div style="
                    border: 2px solid #fce7f3;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                  ">
                  <h3 style="
                      margin: 0;
                      font-size: 1rem;
                      font-weight: 600;
                      color: #9f1239;
                    ">
                    Secondary counter
                  </h3>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      flex-wrap: wrap;
                    ">
                    <ct-button onClick={increaseSecondary}>
                      + {secondaryStepDisplay}
                    </ct-button>
                    <ct-button variant="secondary" onClick={decreaseSecondary}>
                      − {secondaryStepDisplay}
                    </ct-button>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="secondary-step"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Step size
                    </label>
                    <ct-input
                      id="secondary-step"
                      type="number"
                      min="1"
                      step="1"
                      $value={secondaryStepField}
                      aria-label="Secondary step size"
                    >
                    </ct-input>
                    <ct-button onClick={updateSecondaryStep}>
                      Update to {secondaryStepCandidate}
                    </ct-button>
                  </div>
                </div>
              </div>

              <div style="
                  background: #f1f5f9;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  font-size: 0.9rem;
                  color: #334155;
                ">
                <strong>Formula:</strong>{" "}
                Difference = Primary ({primaryDisplay}) − Secondary
                ({secondaryDisplay}) = {differenceDisplay}
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Adjustment audit log
              </h3>
              <ct-badge variant="outline">
                {sequenceDisplay} adjustments
              </ct-badge>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                gap: 0.5rem;
              "
            >
              {auditCards}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {status}
          </div>
        </div>
      ),
      primaryValue,
      secondaryValue,
      primaryStepValue,
      secondaryStepValue,
      differenceValue,
      differenceSummary,
      summaryLabel,
      differenceHistory,
      auditLog,
      primaryDisplay,
      secondaryDisplay,
      differenceDisplay,
      primaryStepDisplay,
      secondaryStepDisplay,
      sequenceDisplay,
      auditLogView,
      auditCards,
      name,
      status,
      inputs: {
        primaryStepField,
        secondaryStepField,
        primaryStepCandidate,
        secondaryStepCandidate,
      },
      controls: {
        increasePrimary,
        decreasePrimary,
        increaseSecondary,
        decreaseSecondary,
        updatePrimaryStep,
        updateSecondaryStep,
      },
    };
  },
);

export default counterWithDerivedDifferenceUx;
