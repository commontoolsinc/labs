/// <cts-enable />
import {
  type Cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
  toSchema,
} from "commontools";

interface DerivedMinMaxArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const resolveAmount = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 1;
  }
  return Math.trunc(input);
};

const sanitizeHistory = (entries: number[] | undefined): number[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const entry of entries) {
    sanitized.push(toInteger(entry));
  }
  return sanitized;
};

const minimumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let min = values[0];
  for (const value of values) {
    if (value < min) {
      min = value;
    }
  }
  return min;
};

const maximumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let max = values[0];
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  return max;
};

const adjustCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const current = toInteger(context.value.get());
    const next = current + amount;
    context.value.set(next);
    context.history.push(next);
  },
);

const computeLimits = lift(
  toSchema<{ values: Cell<number[]>; current: Cell<number> }>(),
  toSchema<{ min: number; max: number }>(),
  ({ values, current }) => {
    const entries = sanitizeHistory(values.get());
    const baseline = toInteger(current.get());
    if (entries.length === 0) {
      return { min: baseline, max: baseline };
    }
    return {
      min: minimumOf(entries),
      max: maximumOf(entries),
    };
  },
);

export const counterWithDerivedMinMax = recipe<DerivedMinMaxArgs>(
  "Counter With Derived Min Max",
  ({ value, history }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const historyValues = lift(sanitizeHistory)(history);
    const limits = computeLimits({
      values: historyValues,
      current: currentValue,
    });
    const minValue = derive(limits, (snapshot) => snapshot.min);
    const maxValue = derive(limits, (snapshot) => snapshot.max);
    const label = str`Min: ${minValue}, Max: ${maxValue}`;

    return {
      value,
      history: historyValues,
      minValue,
      maxValue,
      label,
      adjust: adjustCounter({ value, history }),
    };
  },
);
