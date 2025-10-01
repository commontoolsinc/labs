/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

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

// UI-specific handlers
const incrementCounter = (counterIndex: number) =>
  handler(
    (_event: unknown, context: { counts: Cell<number[]> }) => {
      const counts = sanitizeCounts(context.counts.get());
      if (counterIndex >= 0 && counterIndex < counts.length) {
        counts[counterIndex] = counts[counterIndex] + 1;
        context.counts.set(counts);
      }
    },
  );

const decrementCounter = (counterIndex: number) =>
  handler(
    (_event: unknown, context: { counts: Cell<number[]> }) => {
      const counts = sanitizeCounts(context.counts.get());
      if (counterIndex >= 0 && counterIndex < counts.length) {
        counts[counterIndex] = counts[counterIndex] - 1;
        context.counts.set(counts);
      }
    },
  );

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

    // Create handlers for each counter index
    const inc0 = incrementCounter(0);
    const dec0 = decrementCounter(0);
    const inc1 = incrementCounter(1);
    const dec1 = decrementCounter(1);
    const inc2 = incrementCounter(2);
    const dec2 = decrementCounter(2);

    // Compute display properties for each counter
    const counter0Value = lift((counts: number[]) => counts[0] ?? 0)(
      normalizedCounts,
    );
    const counter1Value = lift((counts: number[]) => counts[1] ?? 0)(
      normalizedCounts,
    );
    const counter2Value = lift((counts: number[]) => counts[2] ?? 0)(
      normalizedCounts,
    );

    const counter0IsSelected = lift(
      (idx: number) => idx === 0,
    )(selectedIndex);
    const counter1IsSelected = lift(
      (idx: number) => idx === 1,
    )(selectedIndex);
    const counter2IsSelected = lift(
      (idx: number) => idx === 2,
    )(selectedIndex);

    const counter0Style = lift(
      (selected: boolean) =>
        selected
          ? "background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;"
          : "background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;",
    )(counter0IsSelected);

    const counter1Style = lift(
      (selected: boolean) =>
        selected
          ? "background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;"
          : "background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;",
    )(counter1IsSelected);

    const counter2Style = lift(
      (selected: boolean) =>
        selected
          ? "background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;"
          : "background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border-radius: 8px; padding: 1.5rem; color: white; position: relative;",
    )(counter2IsSelected);

    const badge0Style = lift(
      (selected: boolean) =>
        "display: " + (selected ? "block" : "none") +
        "; position: absolute; top: 0.75rem; right: 0.75rem; background: rgba(255,255,255,0.3); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;",
    )(counter0IsSelected);

    const badge1Style = lift(
      (selected: boolean) =>
        "display: " + (selected ? "block" : "none") +
        "; position: absolute; top: 0.75rem; right: 0.75rem; background: rgba(255,255,255,0.3); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;",
    )(counter1IsSelected);

    const badge2Style = lift(
      (selected: boolean) =>
        "display: " + (selected ? "block" : "none") +
        "; position: absolute; top: 0.75rem; right: 0.75rem; background: rgba(255,255,255,0.3); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;",
    )(counter2IsSelected);

    const name = str`Computed Child Selection: ${selectedName}`;
    const ui = (
      <div style="max-width: 900px; margin: 0 auto; padding: 1rem; font-family: system-ui, -apple-system, sans-serif;">
        <div style="background: #f8fafc; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 0.5rem 0; font-size: 1.125rem; color: #1e293b; font-weight: 600;">
            Computed Child Selection
          </h2>
          <p style="margin: 0; font-size: 0.875rem; color: #64748b; line-height: 1.5;">
            Increment or decrement any counter. The counter with the highest
            value is automatically highlighted and selected.
          </p>
        </div>

        <div style="background: white; border: 2px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <div style="text-align: center;">
            <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">
              Current Selection
            </div>
            <div style="font-size: 2rem; font-weight: 700; color: #10b981; font-family: monospace;">
              {selectedName}
            </div>
            <div style="font-size: 1.25rem; color: #64748b; margin-top: 0.25rem;">
              Value:{" "}
              <span style="font-weight: 600; color: #1e293b; font-family: monospace;">
                {selectedValue}
              </span>
            </div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1.5rem;">
          <div style={counter0Style}>
            <div style={badge0Style}>★ Highest</div>
            <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">
              Counter 1
            </div>
            <div style="font-size: 3rem; font-weight: 700; margin-bottom: 1rem;">
              {counter0Value}
            </div>
            <div style="display: flex; gap: 0.5rem; justify-content: center;">
              <ct-button
                onClick={inc0({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                +1
              </ct-button>
              <ct-button
                onClick={dec0({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                -1
              </ct-button>
            </div>
          </div>

          <div style={counter1Style}>
            <div style={badge1Style}>★ Highest</div>
            <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">
              Counter 2
            </div>
            <div style="font-size: 3rem; font-weight: 700; margin-bottom: 1rem;">
              {counter1Value}
            </div>
            <div style="display: flex; gap: 0.5rem; justify-content: center;">
              <ct-button
                onClick={inc1({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                +1
              </ct-button>
              <ct-button
                onClick={dec1({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                -1
              </ct-button>
            </div>
          </div>

          <div style={counter2Style}>
            <div style={badge2Style}>★ Highest</div>
            <div style="font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;">
              Counter 3
            </div>
            <div style="font-size: 3rem; font-weight: 700; margin-bottom: 1rem;">
              {counter2Value}
            </div>
            <div style="display: flex; gap: 0.5rem; justify-content: center;">
              <ct-button
                onClick={inc2({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                +1
              </ct-button>
              <ct-button
                onClick={dec2({ counts })}
                style="padding: 0.5rem 1rem; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.2); color: white; border-radius: 6px; font-size: 1rem; font-weight: 600;"
              >
                -1
              </ct-button>
            </div>
          </div>
        </div>

        <div style="margin-top: 1.5rem; background: #fefce8; border: 2px solid #fde047; border-radius: 8px; padding: 1rem;">
          <div style="font-size: 0.875rem; color: #854d0e; font-weight: 500; margin-bottom: 0.5rem;">
            Pattern Details
          </div>
          <div style="font-size: 0.875rem; color: #a16207; line-height: 1.5;">
            This pattern demonstrates automatic selection based on computed
            properties. The counter with the highest value is automatically
            selected and highlighted with a green gradient and star badge. Try
            incrementing different counters to see the selection change
            dynamically.
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
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
