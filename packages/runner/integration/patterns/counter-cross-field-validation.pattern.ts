/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
  toSchema,
} from "commontools";

interface CrossFieldValidationArgs {
  value: Default<number, 0>;
  limit: Default<number, 10>;
  step: Default<number, 1>;
}

type AdjustmentDirection = "increase" | "decrease";

interface AdjustmentEvent {
  amount?: number;
  direction?: AdjustmentDirection;
}

interface LimitEvent {
  limit?: number;
}

interface ValidationEntry {
  value: number;
  limit: number;
  hasError: boolean;
}

interface ValidationSnapshot extends ValidationEntry {
  difference: number;
}

interface ValidationContext {
  value: Cell<number>;
  limit: Cell<number>;
  audit: Cell<ValidationEntry[]>;
}

const toInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const toPositiveStep = (value: unknown, fallback: number): number => {
  const sanitized = Math.abs(toInteger(value, fallback));
  if (sanitized === 0) {
    const safeFallback = Math.abs(fallback) || 1;
    return safeFallback;
  }
  return sanitized;
};

const resolveAmount = (
  event: AdjustmentEvent | number | undefined,
  step: number,
): number => {
  if (typeof event === "number") {
    return toInteger(event, step);
  }
  if (typeof event?.amount === "number") {
    return toInteger(event.amount, step);
  }
  if (event?.direction === "decrease") {
    return -step;
  }
  if (event?.direction === "increase") {
    return step;
  }
  return step;
};

const recordSnapshot = (context: ValidationContext): void => {
  const currentValue = toInteger(context.value.get(), 0);
  const limitValue = toInteger(context.limit.get(), 10);
  context.audit.push({
    value: currentValue,
    limit: limitValue,
    hasError: currentValue > limitValue,
  });
};

const adjustValue = handler(
  (
    event: AdjustmentEvent | number | undefined,
    context: ValidationContext & { step: Cell<number> },
  ) => {
    const step = toPositiveStep(context.step.get(), 1);
    const delta = resolveAmount(event, step);
    const current = toInteger(context.value.get(), 0);
    context.value.set(current + delta);
    recordSnapshot(context);
  },
);

const updateLimit = handler(
  (
    event: LimitEvent | number | undefined,
    context: ValidationContext,
  ) => {
    const fallback = toInteger(context.limit.get(), 10);
    const raw = typeof event === "number" ? event : event?.limit;
    const next = toInteger(raw, fallback);
    context.limit.set(next);
    recordSnapshot(context);
  },
);

export const counterWithCrossFieldValidation = recipe<CrossFieldValidationArgs>(
  "Counter With Cross Field Validation",
  ({ value, limit, step }) => {
    const auditTrail = cell<ValidationEntry[]>([]);
    const sanitizedValue = lift((input: number | undefined) =>
      toInteger(input, 0)
    )(value);
    const sanitizedLimit = lift((input: number | undefined) =>
      toInteger(input, 10)
    )(limit);
    const sanitizedStep = lift((input: number | undefined) =>
      toPositiveStep(input, 1)
    )(step);

    const validationView = lift(
      toSchema<{ value: Cell<number>; limit: Cell<number> }>(),
      toSchema<ValidationSnapshot>(),
      ({ value: current, limit: bound }) => {
        const currentValue = toInteger(current.get(), 0);
        const limitValue = toInteger(bound.get(), 10);
        const difference = currentValue - limitValue;
        return {
          value: currentValue,
          limit: limitValue,
          difference,
          hasError: difference > 0,
        };
      },
    )({
      value: sanitizedValue,
      limit: sanitizedLimit,
    });

    const currentValueView = derive(
      validationView,
      (snapshot) => snapshot.value,
    );
    const limitValueView = derive(
      validationView,
      (snapshot) => snapshot.limit,
    );
    const differenceView = derive(
      validationView,
      (snapshot) => snapshot.difference,
    );
    const hasError = derive(validationView, (snapshot) => snapshot.hasError);
    const summary =
      str`Value ${currentValueView} / Limit ${limitValueView} (Δ ${differenceView})`;

    return {
      currentValue: currentValueView,
      limitValue: limitValueView,
      stepSize: sanitizedStep,
      difference: differenceView,
      hasError,
      summary,
      auditTrail,
      adjustValue: adjustValue({
        value,
        limit,
        step,
        audit: auditTrail,
      }),
      updateLimit: updateLimit({
        value,
        limit,
        audit: auditTrail,
      }),
    };
  },
);
