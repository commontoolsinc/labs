/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

interface FallbackDefaultsArgs {
  slots: Default<(number | undefined)[], []>;
  fallback: Default<number, 0>;
  expectedLength: Default<number, 0>;
}

interface SlotUpdateEvent {
  index?: number;
  amount?: number;
  value?: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const sanitizeNumber = (value: unknown, fallback: number): number =>
  isFiniteNumber(value) ? value : fallback;

const ensureArrayWithFallback = (
  raw: unknown,
  fallback: number,
  requiredLength: number,
): number[] => {
  const source = Array.isArray(raw) ? [...raw] : [];
  if (source.length < requiredLength) {
    source.length = requiredLength;
  }
  for (let index = 0; index < source.length; index++) {
    source[index] = sanitizeNumber(source[index], fallback);
  }
  return source;
};

const updateSlot = handler(
  (
    event: SlotUpdateEvent | undefined,
    context: {
      slots: Cell<(number | undefined)[]>;
      fallback: Cell<number>;
      expectedLength: Cell<number>;
    },
  ) => {
    const rawIndex = event?.index;
    if (!isFiniteNumber(rawIndex)) return;

    const index = Math.max(0, Math.floor(rawIndex));
    const fallbackValue = sanitizeNumber(context.fallback.get(), 0);
    const expected = context.expectedLength.get();
    const rawAmount = event?.amount;
    const amount = isFiniteNumber(rawAmount) ? rawAmount : 1;

    const rawSlots = context.slots.get();
    const currentLength = Array.isArray(rawSlots) ? rawSlots.length : 0;
    const requiredLength = Math.max(currentLength, expected, index + 1);
    const normalized = ensureArrayWithFallback(
      rawSlots,
      fallbackValue,
      requiredLength,
    );

    const rawValue = event?.value;
    if (isFiniteNumber(rawValue)) {
      normalized[index] = rawValue;
    } else {
      const baseValue = sanitizeNumber(normalized[index], fallbackValue);
      normalized[index] = baseValue + amount;
    }

    context.slots.set(normalized);
  },
);

export const counterWithFallbackDefaults = recipe<FallbackDefaultsArgs>(
  "Counter With Fallback Defaults",
  ({ slots, fallback, expectedLength }) => {
    const normalizedFallback = lift((value: number | undefined) =>
      sanitizeNumber(value, 0)
    )(fallback);
    const normalizedExpected = lift((value: number | undefined) => {
      if (isFiniteNumber(value) && value >= 0) {
        return Math.floor(value);
      }
      return 0;
    })(expectedLength);

    const dense = lift(
      (
        input: {
          raw: (number | undefined)[] | undefined;
          fallback: number;
          expected: number;
        },
      ) => {
        const base = Array.isArray(input.raw) ? input.raw : [];
        const length = Math.max(base.length, input.expected);
        const result: number[] = [];
        for (let index = 0; index < length; index++) {
          result.push(sanitizeNumber(base[index], input.fallback));
        }
        return result;
      },
    )({
      raw: slots,
      fallback: normalizedFallback,
      expected: normalizedExpected,
    });

    const total = lift((entries: number[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) return 0;
      return entries.reduce((sum, value) => sum + value, 0);
    })(dense);

    const densePreview = lift((entries: number[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) return "empty";
      return entries.join(", ");
    })(dense);

    const label = str`Dense values [${densePreview}] total ${total}`;

    const adjustSlot = updateSlot({
      slots,
      fallback: normalizedFallback,
      expectedLength: normalizedExpected,
    });

    return {
      slots,
      fallback: normalizedFallback,
      expectedLength: normalizedExpected,
      dense,
      densePreview,
      total,
      label,
      updateSlot: adjustSlot,
      increment: adjustSlot,
    };
  },
);
