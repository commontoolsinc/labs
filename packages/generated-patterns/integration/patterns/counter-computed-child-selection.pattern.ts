/// <cts-enable />
import { Cell, Default, derive, handler, lift, recipe, str } from "commontools";

const defaultCounterSeed = [2, 5, 3];

interface ComputedChildSelectionArgs {
  counts: Default<number[], typeof defaultCounterSeed>;
}

interface AdjustEvent {
  index?: number;
  amount?: number;
}

interface ChildView {
  index: number;
  name: string;
  value: number;
  label: string;
}

const sanitizeCounts = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [...defaultCounterSeed];
  const sanitized: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      sanitized.push(entry);
    } else {
      sanitized.push(0);
    }
  }
  return sanitized.length > 0 ? sanitized : [...defaultCounterSeed];
};

const adjustCounter = handler(
  (
    event: AdjustEvent | undefined,
    context: { counts: Cell<number[]> },
  ) => {
    if (!event) return;

    const rawIndex = typeof event.index === "number" ? event.index : NaN;
    if (!Number.isFinite(rawIndex)) return;
    const index = Math.trunc(rawIndex);

    const counts = sanitizeCounts(context.counts.get());
    if (index < 0 || index >= counts.length) return;

    const delta = typeof event.amount === "number" &&
        Number.isFinite(event.amount)
      ? event.amount
      : 1;
    const current = typeof counts[index] === "number" &&
        Number.isFinite(counts[index])
      ? counts[index]
      : 0;

    counts[index] = current + delta;
    context.counts.set(counts);
  },
);

const buildChildViews = (values: number[]): ChildView[] => {
  return values.map((value, index) => ({
    index,
    name: `Counter ${index + 1}`,
    value,
    label: `Counter ${index + 1} value ${value}`,
  }));
};

const fallbackSelection: ChildView = {
  index: 0,
  name: "Counter 1",
  value: 0,
  label: "Counter 1 value 0",
};

export const counterComputedChildSelection = recipe<ComputedChildSelectionArgs>(
  "Counter With Computed Child Selection",
  ({ counts }) => {
    const normalizedCounts = lift(sanitizeCounts)(counts);
    const children = lift(buildChildViews)(normalizedCounts);

    const selection = derive(children, (list) => {
      if (!Array.isArray(list) || list.length === 0) {
        return fallbackSelection;
      }

      let best = list[0];
      for (let index = 1; index < list.length; index++) {
        const candidate = list[index];
        if (typeof candidate?.value !== "number") continue;
        if (candidate.value > best.value) {
          best = candidate;
        }
      }
      return best ?? fallbackSelection;
    });

    const selectedIndex = derive(selection, (entry) => entry.index);
    const selectedName = derive(selection, (entry) => entry.name);
    const selectedValue = derive(selection, (entry) => entry.value);
    const selectedLabel = derive(selection, (entry) => entry.label);

    const summary = str`Displaying ${selectedName} (${selectedValue})`;

    return {
      counts: normalizedCounts,
      children,
      selectedIndex,
      selectedName,
      selectedValue,
      selectedLabel,
      summary,
      adjust: adjustCounter({ counts }),
    };
  },
);
