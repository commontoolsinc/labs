/// <cts-enable />
import { type Cell, Default, handler, lift, recipe, str } from "commontools";

interface NestedDeriveArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

interface SetValueEvent {
  value?: number;
}

const sanitizeNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const adjustValue = handler(
  (
    event: IncrementEvent | undefined,
    context: { value: Cell<number> },
  ) => {
    const base = sanitizeNumber(context.value.get(), 0);
    const delta = sanitizeNumber(event?.amount, 1);
    context.value.set(base + delta);
  },
);

const setValue = handler(
  (
    event: SetValueEvent | undefined,
    context: { value: Cell<number> },
  ) => {
    const next = sanitizeNumber(event?.value, 0);
    context.value.set(next);
  },
);

export const counterWithNestedDeriveWatchers = recipe<NestedDeriveArgs>(
  "Counter With Nested Derive Watchers",
  ({ value }) => {
    const current = lift((raw: number | undefined) =>
      typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0
    )(value);

    const magnitude = lift((count: number) => Math.abs(count))(current);
    const parity = lift((absolute: number) =>
      Math.abs(absolute % 2) === 0 ? "even" : "odd"
    )(magnitude);
    const emphasis = lift((label: "even" | "odd") =>
      label === "even" ? "steady" : "swing"
    )(parity);
    const parityCode = lift((label: "steady" | "swing") =>
      label === "steady" ? 0 : 1
    )(emphasis);

    const parityDetail = str`parity ${parity} emphasis ${emphasis}`;
    const summary =
      str`value ${current} magnitude ${magnitude} code ${parityCode}`;

    return {
      value,
      current,
      magnitude,
      parity,
      emphasis,
      parityCode,
      parityDetail,
      summary,
      increment: adjustValue({ value }),
      setValue: setValue({ value }),
    };
  },
);
