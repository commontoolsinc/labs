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

type FieldValueMap = Record<string, Record<string, string>>;

type StepStatus = "pending" | "active" | "complete";

interface WizardFieldConfig {
  id?: string;
  label?: string;
  required?: unknown;
}

interface WizardStepConfig {
  id?: string;
  label?: string;
  fields?: WizardFieldConfig[];
}

interface WizardField {
  id: string;
  label: string;
  required: boolean;
}

interface WizardStep {
  id: string;
  label: string;
  fields: WizardField[];
}

interface WizardFieldState extends WizardField {
  value: string;
  valid: boolean;
}

interface WizardStepState {
  id: string;
  label: string;
  status: StepStatus;
  complete: boolean;
  remaining: string[];
  fields: WizardFieldState[];
}

const defaultWizardSteps: WizardStepConfig[] = [
  {
    id: "profile",
    label: "Profile",
    fields: [
      { id: "name", label: "Full Name", required: true },
      { id: "email", label: "Email", required: true },
    ],
  },
  {
    id: "details",
    label: "Details",
    fields: [
      { id: "address", label: "Address", required: true },
      { id: "city", label: "City", required: true },
    ],
  },
  {
    id: "confirmation",
    label: "Confirmation",
    fields: [
      { id: "agreement", label: "Agreement", required: true },
    ],
  },
];

interface FormWizardStepperArgs {
  steps: Default<WizardStepConfig[], typeof defaultWizardSteps>;
  currentStepIndex: Default<number, 0>;
  fieldValues: Default<FieldValueMap, {}>;
}

interface UpdateFieldEvent {
  stepId?: unknown;
  fieldId?: unknown;
  value?: unknown;
}

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeIdentifier = (value: unknown): string | null => {
  const text = sanitizeText(value);
  if (!text) return null;
  return text.toLowerCase().replaceAll(/[^a-z0-9-]/gi, "-");
};

const buildFallbackFieldId = (stepId: string, index: number): string => {
  return `${stepId}-field-${index + 1}`;
};

const sanitizeFieldConfig = (
  config: WizardFieldConfig | undefined,
  stepId: string,
  index: number,
): WizardField | null => {
  const fallbackId = buildFallbackFieldId(stepId, index);
  const id = sanitizeIdentifier(config?.id) ?? fallbackId;
  const label = sanitizeText(config?.label) ?? id;
  const required = config?.required === true;
  return { id, label, required };
};

const sanitizeFields = (
  fields: WizardFieldConfig[] | undefined,
  stepId: string,
): WizardField[] => {
  if (!Array.isArray(fields)) {
    return [
      { id: `${stepId}-confirmation`, label: "Confirmation", required: false },
    ];
  }
  const sanitized: WizardField[] = [];
  const seen = new Set<string>();
  fields.forEach((entry, index) => {
    const result = sanitizeFieldConfig(entry, stepId, index);
    if (!result) return;
    if (seen.has(result.id)) return;
    seen.add(result.id);
    sanitized.push(result);
  });
  if (sanitized.length === 0) {
    return [
      { id: `${stepId}-confirmation`, label: "Confirmation", required: false },
    ];
  }
  return sanitized;
};

const sanitizeSteps = (
  value: WizardStepConfig[] | undefined,
): WizardStep[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultWizardSteps;
  const steps: WizardStep[] = [];
  const seen = new Set<string>();
  source.forEach((entry, index) => {
    const fallbackId = `step-${index + 1}`;
    const id = sanitizeIdentifier(entry?.id) ?? fallbackId;
    if (seen.has(id)) return;
    seen.add(id);
    const label = sanitizeText(entry?.label) ?? id;
    const fields = sanitizeFields(entry?.fields, id);
    steps.push({ id, label, fields });
  });
  if (steps.length === 0 && source !== defaultWizardSteps) {
    return sanitizeSteps(defaultWizardSteps);
  }
  return steps;
};

const sanitizeFieldValue = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
};

const sanitizeFieldValues = (
  value: FieldValueMap | undefined,
  steps: readonly WizardStep[],
): FieldValueMap => {
  const result: FieldValueMap = {};
  const input = (value && typeof value === "object") ? value : {};
  for (const step of steps) {
    const rawStep = (
        typeof input === "object" && input !== null
      )
      ? (input as Record<string, unknown>)[step.id]
      : undefined;
    const stepValues: Record<string, string> = {};
    for (const field of step.fields) {
      const rawValue = (
          typeof rawStep === "object" && rawStep !== null
        )
        ? (rawStep as Record<string, unknown>)[field.id]
        : undefined;
      stepValues[field.id] = sanitizeFieldValue(rawValue);
    }
    result[step.id] = stepValues;
  }
  return result;
};

const clampIndex = (value: number | undefined, size: number): number => {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value ?? 0);
  if (size <= 0) return 0;
  if (normalized < 0) return 0;
  const max = size - 1;
  return normalized > max ? max : normalized;
};

const evaluateStepStates = (
  steps: readonly WizardStep[],
  values: FieldValueMap,
  activeIndex: number,
): WizardStepState[] => {
  return steps.map((step, index) => {
    const stepValues = values[step.id] ?? {};
    const fields = step.fields.map((field) => {
      const value = stepValues[field.id] ?? "";
      const valid = field.required ? value.length > 0 : true;
      return { ...field, value, valid };
    });
    const remaining = fields
      .filter((field) => !field.valid)
      .map((field) => field.id);
    const complete = remaining.length === 0;
    const status: StepStatus = index < activeIndex
      ? "complete"
      : index === activeIndex
      ? "active"
      : "pending";
    return {
      id: step.id,
      label: step.label,
      status,
      complete,
      remaining,
      fields,
    };
  });
};

const formatBlockMessage = (
  step: WizardStep,
  missing: readonly WizardField[],
): string => {
  const labels = missing.map((field) => field.label).join(", ");
  return `${step.label} blocked: ${labels} required`;
};

const collectMissingFields = (
  step: WizardStep,
  values: FieldValueMap,
): WizardField[] => {
  const stepValues = values[step.id] ?? {};
  return step.fields.filter((field) => {
    const value = stepValues[field.id] ?? "";
    return field.required && value.length === 0;
  });
};

const buildProgressLabel = (
  step: WizardStep | undefined,
  index: number,
  count: number,
): string => {
  const total = count === 0 ? 0 : count;
  const position = count === 0 ? 0 : index + 1;
  const label = step?.label ?? "Step";
  return `${label} (${position} of ${total})`;
};

export const formWizardStepperUx = recipe<FormWizardStepperArgs>(
  "Form Wizard Stepper",
  ({ steps, currentStepIndex, fieldValues }) => {
    const blockReason = cell<string | null>(null);

    const stepsView = lift(sanitizeSteps)(steps);
    const stepCount = lift((list: WizardStep[]) => list.length)(stepsView);

    const activeIndex = lift(
      (input: { index: number | undefined; count: number }) => {
        return clampIndex(input.index, input.count);
      },
    )({ index: currentStepIndex, count: stepCount });

    const valuesView = lift(
      (input: { values: FieldValueMap | undefined; steps: WizardStep[] }) =>
        sanitizeFieldValues(input.values, input.steps),
    )({ values: fieldValues, steps: stepsView });

    const stepStates = lift(
      (
        input: {
          steps: WizardStep[];
          values: FieldValueMap;
          index: number;
        },
      ) => evaluateStepStates(input.steps, input.values, input.index),
    )({ steps: stepsView, values: valuesView, index: activeIndex });

    const activeStep = lift(
      (input: { steps: WizardStep[]; index: number }) => {
        if (input.steps.length === 0) return undefined;
        return input.steps[input.index];
      },
    )({ steps: stepsView, index: activeIndex });

    const canAdvance = lift(
      (input: { states: WizardStepState[]; index: number }) => {
        const active = input.states[input.index];
        return active ? active.remaining.length === 0 : false;
      },
    )({ states: stepStates, index: activeIndex });

    const progress = lift(
      (input: { step?: WizardStep; index: number; count: number }) =>
        buildProgressLabel(input.step, input.index, input.count),
    )({ step: activeStep, index: activeIndex, count: stepCount });

    const progressSummary = str`${progress}`;

    const blockMessage = lift((value: string | null) => value ?? "")(
      blockReason,
    );

    const handlerContext = {
      stepsView,
      fieldValues,
      currentStepIndex,
      blockReason,
    } as const;

    const advanceStep = handler(
      (
        _event: unknown,
        context: {
          stepsView: Cell<WizardStep[]>;
          fieldValues: Cell<FieldValueMap>;
          currentStepIndex: Cell<number>;
          blockReason: Cell<string | null>;
        },
      ) => {
        const stepsList = context.stepsView.get();
        if (stepsList.length === 0) return;
        const sanitizedValues = sanitizeFieldValues(
          context.fieldValues.get(),
          stepsList,
        );
        const currentIndex = clampIndex(
          context.currentStepIndex.get(),
          stepsList.length,
        );
        const step = stepsList[currentIndex];
        const missing = collectMissingFields(step, sanitizedValues);
        if (missing.length > 0) {
          context.fieldValues.set(sanitizedValues);
          context.currentStepIndex.set(currentIndex);
          context.blockReason.set(formatBlockMessage(step, missing));
          return;
        }
        const nextIndex = Math.min(currentIndex + 1, stepsList.length - 1);
        context.fieldValues.set(sanitizedValues);
        context.currentStepIndex.set(nextIndex);
        context.blockReason.set(null);
      },
    );

    const retreatStep = handler(
      (
        _event: unknown,
        context: {
          stepsView: Cell<WizardStep[]>;
          currentStepIndex: Cell<number>;
          blockReason: Cell<string | null>;
        },
      ) => {
        const stepsList = context.stepsView.get();
        if (stepsList.length === 0) return;
        const currentIndex = clampIndex(
          context.currentStepIndex.get(),
          stepsList.length,
        );
        const previousIndex = Math.max(currentIndex - 1, 0);
        context.currentStepIndex.set(previousIndex);
        context.blockReason.set(null);
      },
    );

    const updateField = handler(
      (
        event: UpdateFieldEvent | undefined,
        context: {
          stepsView: Cell<WizardStep[]>;
          fieldValues: Cell<FieldValueMap>;
          currentStepIndex: Cell<number>;
          blockReason: Cell<string | null>;
        },
      ) => {
        const stepsList = context.stepsView.get();
        if (stepsList.length === 0) return;
        const sanitizedValues = sanitizeFieldValues(
          context.fieldValues.get(),
          stepsList,
        );
        const fallbackIndex = clampIndex(
          context.currentStepIndex.get(),
          stepsList.length,
        );
        const fallbackStep = stepsList[fallbackIndex];
        const explicitStepId = sanitizeIdentifier(event?.stepId);
        const targetStep =
          stepsList.find((entry) => entry.id === explicitStepId) ??
            fallbackStep;
        if (!targetStep) return;
        const fieldId = sanitizeIdentifier(event?.fieldId);
        if (!fieldId) return;
        const field = targetStep.fields.find((entry) => entry.id === fieldId);
        if (!field) return;
        const value = sanitizeFieldValue(event?.value);
        const nextValues = sanitizeFieldValues(sanitizedValues, stepsList);
        nextValues[targetStep.id][field.id] = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    // UI-specific cells - one per field per step
    const profileNameField = cell<string>("");
    const profileEmailField = cell<string>("");
    const detailsAddressField = cell<string>("");
    const detailsCityField = cell<string>("");
    const confirmationAgreementField = cell<string>("");

    // Sync UI fields with values
    compute(() => {
      const values = valuesView.get();
      if (!values) return;

      if (values.profile?.name !== undefined) {
        const current = profileNameField.get();
        if (current !== values.profile.name) {
          profileNameField.set(values.profile.name);
        }
      }
      if (values.profile?.email !== undefined) {
        const current = profileEmailField.get();
        if (current !== values.profile.email) {
          profileEmailField.set(values.profile.email);
        }
      }
      if (values.details?.address !== undefined) {
        const current = detailsAddressField.get();
        if (current !== values.details.address) {
          detailsAddressField.set(values.details.address);
        }
      }
      if (values.details?.city !== undefined) {
        const current = detailsCityField.get();
        if (current !== values.details.city) {
          detailsCityField.set(values.details.city);
        }
      }
      if (values.confirmation?.agreement !== undefined) {
        const current = confirmationAgreementField.get();
        if (current !== values.confirmation.agreement) {
          confirmationAgreementField.set(values.confirmation.agreement);
        }
      }
    });

    // Handlers to update each field
    const updateProfileName = handler(
      (_event: unknown, context: {
        profileNameField: Cell<string>;
        fieldValues: Cell<FieldValueMap>;
        stepsView: Cell<WizardStep[]>;
        blockReason: Cell<string | null>;
      }) => {
        const value = context.profileNameField.get() || "";
        const steps = context.stepsView.get();
        const currentValues = sanitizeFieldValues(
          context.fieldValues.get(),
          steps,
        );
        const nextValues = sanitizeFieldValues(currentValues, steps);
        nextValues.profile = nextValues.profile || {};
        nextValues.profile.name = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    const updateProfileEmail = handler(
      (_event: unknown, context: {
        profileEmailField: Cell<string>;
        fieldValues: Cell<FieldValueMap>;
        stepsView: Cell<WizardStep[]>;
        blockReason: Cell<string | null>;
      }) => {
        const value = context.profileEmailField.get() || "";
        const steps = context.stepsView.get();
        const currentValues = sanitizeFieldValues(
          context.fieldValues.get(),
          steps,
        );
        const nextValues = sanitizeFieldValues(currentValues, steps);
        nextValues.profile = nextValues.profile || {};
        nextValues.profile.email = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    const updateDetailsAddress = handler(
      (_event: unknown, context: {
        detailsAddressField: Cell<string>;
        fieldValues: Cell<FieldValueMap>;
        stepsView: Cell<WizardStep[]>;
        blockReason: Cell<string | null>;
      }) => {
        const value = context.detailsAddressField.get() || "";
        const steps = context.stepsView.get();
        const currentValues = sanitizeFieldValues(
          context.fieldValues.get(),
          steps,
        );
        const nextValues = sanitizeFieldValues(currentValues, steps);
        nextValues.details = nextValues.details || {};
        nextValues.details.address = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    const updateDetailsCity = handler(
      (_event: unknown, context: {
        detailsCityField: Cell<string>;
        fieldValues: Cell<FieldValueMap>;
        stepsView: Cell<WizardStep[]>;
        blockReason: Cell<string | null>;
      }) => {
        const value = context.detailsCityField.get() || "";
        const steps = context.stepsView.get();
        const currentValues = sanitizeFieldValues(
          context.fieldValues.get(),
          steps,
        );
        const nextValues = sanitizeFieldValues(currentValues, steps);
        nextValues.details = nextValues.details || {};
        nextValues.details.city = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    const updateConfirmationAgreement = handler(
      (_event: unknown, context: {
        confirmationAgreementField: Cell<string>;
        fieldValues: Cell<FieldValueMap>;
        stepsView: Cell<WizardStep[]>;
        blockReason: Cell<string | null>;
      }) => {
        const value = context.confirmationAgreementField.get() || "";
        const steps = context.stepsView.get();
        const currentValues = sanitizeFieldValues(
          context.fieldValues.get(),
          steps,
        );
        const nextValues = sanitizeFieldValues(currentValues, steps);
        nextValues.confirmation = nextValues.confirmation || {};
        nextValues.confirmation.agreement = value;
        context.fieldValues.set(nextValues);
        context.blockReason.set(null);
      },
    );

    const updateHandlers = {
      profileNameField,
      profileEmailField,
      detailsAddressField,
      detailsCityField,
      confirmationAgreementField,
      fieldValues,
      stepsView,
      blockReason,
    } as const;

    // UI renders
    const name = lift(
      (input: { step?: WizardStep; index: number; count: number }) =>
        buildProgressLabel(input.step, input.index, input.count),
    )({ step: activeStep, index: activeIndex, count: stepCount });

    const stepDisplay = lift((idx: number) =>
      idx === 0 ? "step1" : idx === 1 ? "step2" : "step3"
    )(activeIndex);

    const ui = (
      <div style="max-width: 800px; margin: 0 auto; padding: 2rem; font-family: system-ui, -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        {lift((input: { states: WizardStepState[]; activeIdx: number }) => {
          const progressPct = input.states.length > 0
            ? Math.round((input.activeIdx / (input.states.length - 1)) * 100)
            : 0;
          const activeState = input.states[input.activeIdx];

          const indicators = [];
          for (let i = 0; i < input.states.length; i++) {
            const state = input.states[i];
            const isActive = i === input.activeIdx;
            const bgColor = state.status === "complete"
              ? "#10b981"
              : state.status === "active"
              ? "#3b82f6"
              : "#e5e7eb";
            const textColor = state.status === "pending"
              ? "#6b7280"
              : "#ffffff";
            const borderColor = isActive ? "#1e40af" : "transparent";

            indicators.push(
              h("div", {
                style:
                  "display: flex; flex-direction: column; align-items: center; flex: 1; position: relative;",
              }, [
                h("div", {
                  style:
                    "width: 2.5rem; height: 2.5rem; border-radius: 50%; background: " +
                    bgColor + "; color: " + textColor +
                    "; display: flex; align-items: center; justify-content: center; font-weight: 600; border: 3px solid " +
                    borderColor + "; z-index: 1;",
                }, String(i + 1)),
                h("div", {
                  style: "margin-top: 0.5rem; font-size: 0.75rem; color: " +
                    (isActive ? "#1e40af" : "#6b7280") + "; font-weight: " +
                    (isActive ? "600" : "400") + "; text-align: center;",
                }, state.label),
              ]),
            );

            if (i < input.states.length - 1) {
              const lineColor = input.states[i + 1].status === "complete"
                ? "#10b981"
                : "#e5e7eb";
              indicators.push(
                h("div", {
                  style: "flex: 1; height: 2px; background: " + lineColor +
                    "; align-self: flex-start; margin-top: 1.25rem;",
                }),
              );
            }
          }

          return h("div", {}, [
            h("div", {
              style:
                "background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1); margin-bottom: 1.5rem;",
            }, [
              h("h1", {
                style:
                  "margin: 0 0 0.5rem 0; font-size: 1.875rem; font-weight: 700; color: #1f2937;",
              }, "Form Wizard"),
              h("div", {
                style:
                  "display: flex; justify-content: space-between; align-items: center; margin-top: 1rem;",
              }, [
                h("p", {
                  style: "margin: 0; color: #6b7280; font-size: 0.875rem;",
                }, "Complete all required fields to proceed"),
                h("div", {
                  style: "display: flex; align-items: center; gap: 0.5rem;",
                }, [
                  h("div", {
                    style:
                      "width: 80px; height: 8px; background: #e5e7eb; border-radius: 9999px; overflow: hidden;",
                  }, [
                    h("div", {
                      style:
                        "height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); width: " +
                        String(progressPct) + "%; transition: width 0.3s;",
                    }),
                  ]),
                  h("span", {
                    style:
                      "font-size: 0.875rem; font-weight: 600; color: #6b7280;",
                  }, String(progressPct) + "%"),
                ]),
              ]),
            ]),
            h("div", {
              style:
                "background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1); margin-bottom: 1.5rem;",
            }, [
              h(
                "div",
                { style: "display: flex; align-items: center; gap: 0;" },
                indicators,
              ),
            ]),
          ]);
        })({ states: stepStates, activeIdx: activeIndex })}

        {/* Step 1: Profile */}
        <div
          style={lift((display: string) =>
            display === "step1" ? "display: block;" : "display: none;"
          )(stepDisplay)}
        >
          <div style="background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
            <h2 style="margin: 0 0 1.5rem 0; font-size: 1.5rem; font-weight: 600; color: #1f2937;">
              Profile
            </h2>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #374151;">
                Full Name *
              </label>
              <ct-input
                $value={profileNameField}
                style="width: 100%; border: 2px solid #d1d5db; border-radius: 0.375rem; padding: 0.5rem; font-size: 1rem;"
                placeholder="Full Name"
              />
            </div>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #374151;">
                Email *
              </label>
              <ct-input
                $value={profileEmailField}
                style="width: 100%; border: 2px solid #d1d5db; border-radius: 0.375rem; padding: 0.5rem; font-size: 1rem;"
                placeholder="Email"
              />
            </div>
          </div>
        </div>

        {/* Step 2: Details */}
        <div
          style={lift((display: string) =>
            display === "step2" ? "display: block;" : "display: none;"
          )(stepDisplay)}
        >
          <div style="background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
            <h2 style="margin: 0 0 1.5rem 0; font-size: 1.5rem; font-weight: 600; color: #1f2937;">
              Details
            </h2>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #374151;">
                Address *
              </label>
              <ct-input
                $value={detailsAddressField}
                style="width: 100%; border: 2px solid #d1d5db; border-radius: 0.375rem; padding: 0.5rem; font-size: 1rem;"
                placeholder="Address"
              />
            </div>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #374151;">
                City *
              </label>
              <ct-input
                $value={detailsCityField}
                style="width: 100%; border: 2px solid #d1d5db; border-radius: 0.375rem; padding: 0.5rem; font-size: 1rem;"
                placeholder="City"
              />
            </div>
          </div>
        </div>

        {/* Step 3: Confirmation */}
        <div
          style={lift((display: string) =>
            display === "step3" ? "display: block;" : "display: none;"
          )(stepDisplay)}
        >
          <div style="background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1); margin-bottom: 1.5rem;">
            <h2 style="margin: 0 0 1.5rem 0; font-size: 1.5rem; font-weight: 600; color: #1f2937;">
              Confirmation
            </h2>
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #374151;">
                Agreement *
              </label>
              <ct-input
                $value={confirmationAgreementField}
                style="width: 100%; border: 2px solid #d1d5db; border-radius: 0.375rem; padding: 0.5rem; font-size: 1rem;"
                placeholder="Type 'I agree' to confirm"
              />
            </div>
          </div>
        </div>

        {/* Error message */}
        {lift((block: string) =>
          block
            ? h("div", {
              style:
                "background: #fee2e2; border: 2px solid #ef4444; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem;",
            }, [
              h(
                "p",
                { style: "margin: 0; color: #dc2626; font-weight: 500;" },
                block,
              ),
            ])
            : h("div", {})
        )(blockMessage)}

        {/* Navigation buttons */}
        <div style="display: flex; gap: 1rem; justify-content: space-between;">
          <ct-button
            onClick={retreatStep(handlerContext as never)}
            disabled={lift((idx: number) => idx === 0)(activeIndex)}
            style="flex: 1; background: #6b7280; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; font-size: 1rem; cursor: pointer; border: none;"
          >
            ← Previous
          </ct-button>
          <ct-button
            onClick={advanceStep(handlerContext as never)}
            disabled={lift((can: boolean) => !can)(canAdvance)}
            style="flex: 1; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; font-size: 1rem; cursor: pointer; border: none;"
          >
            {lift((idx: number) => idx === 2 ? "Complete ✓" : "Next →")(
              activeIndex,
            )}
          </ct-button>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      steps,
      fieldValues,
      currentStepIndex,
      stepsView,
      valuesView,
      activeIndex,
      activeStep,
      stepStates,
      canAdvance,
      progressSummary,
      blockMessage,
      advanceStep: advanceStep(handlerContext as never),
      retreatStep: retreatStep(handlerContext as never),
      updateField: updateField(handlerContext as never),
      updateProfileName: updateProfileName(updateHandlers as never),
      updateProfileEmail: updateProfileEmail(updateHandlers as never),
      updateDetailsAddress: updateDetailsAddress(updateHandlers as never),
      updateDetailsCity: updateDetailsCity(updateHandlers as never),
      updateConfirmationAgreement: updateConfirmationAgreement(
        updateHandlers as never,
      ),
    };
  },
);
