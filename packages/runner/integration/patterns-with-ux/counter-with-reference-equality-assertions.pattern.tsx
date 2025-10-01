/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type Parity = "even" | "odd";

interface ReferenceEqualityArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

interface OverrideEvent {
  value?: number;
}

interface Summary {
  value: number;
  parity: Parity;
  version: number;
}

interface StabilityStatus {
  stable: boolean;
  confirmations: number;
}

function ensureNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: { value: Cell<number>; stability: Cell<StabilityStatus> },
  ) => {
    const amount = event?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return;
    }

    const current = ensureNumber(context.value.get());
    const next = current + amount;
    if (next === current) {
      const status = context.stability.get();
      const confirmations = status.stable ? status.confirmations + 1 : 1;
      context.stability.set({ stable: true, confirmations });
      context.value.set(next);
      return;
    }

    context.value.set(next);
    context.stability.set({ stable: false, confirmations: 0 });
  },
);

const applyOverride = handler(
  (
    event: OverrideEvent | undefined,
    context: { value: Cell<number>; stability: Cell<StabilityStatus> },
  ) => {
    const raw = event?.value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return;
    }

    const current = ensureNumber(context.value.get());
    if (raw === current) {
      const status = context.stability.get();
      const confirmations = status.stable ? status.confirmations + 1 : 1;
      context.stability.set({ stable: true, confirmations });
      context.value.set(raw);
      return;
    }

    context.value.set(raw);
    context.stability.set({ stable: false, confirmations: 0 });
  },
);

/**
 * Counter with UX that keeps a derived summary stable when sanitized value does not
 * change between updates.
 */
export const counterWithReferenceEqualityAssertionsUx = recipe<
  ReferenceEqualityArgs
>(
  "Counter With Reference Equality Assertions (UX)",
  ({ value }) => {
    const currentValue = lift((raw: number | undefined) => ensureNumber(raw))(
      value,
    );

    const summaryCache = cell<Summary>({
      value: 0,
      parity: "even",
      version: 0,
    });
    const stability = cell<StabilityStatus>({
      stable: true,
      confirmations: 1,
    });
    const versionCounter = cell<number>(0);

    const summary = lift((count: number) => {
      const parity: Parity = count % 2 === 0 ? "even" : "odd";
      const cached = summaryCache.get();
      if (cached.value === count && cached.parity === parity) {
        return cached;
      }

      const currentVersion = versionCounter.get();
      const nextVersion =
        typeof currentVersion === "number" && Number.isFinite(currentVersion)
          ? currentVersion + 1
          : 1;
      versionCounter.set(nextVersion);

      const next: Summary = {
        value: count,
        parity,
        version: nextVersion,
      };
      summaryCache.set(next);
      return next;
    })(currentValue);

    const parity = lift((snapshot: Summary) => snapshot.parity)(summary);
    const version = lift((snapshot: Summary) => snapshot.version)(summary);
    const label = str`Value ${currentValue} is ${parity}`;

    const stabilityView = lift((status: StabilityStatus | undefined) =>
      status ?? { stable: true, confirmations: 1 }
    )(stability);

    const incrementAmount = cell<string>("1");
    const overrideValue = cell<string>("0");

    const performIncrement = handler<
      unknown,
      {
        value: Cell<number>;
        stability: Cell<StabilityStatus>;
        incrementAmount: Cell<string>;
      }
    >((_event, { value, stability, incrementAmount }) => {
      const amountStr = incrementAmount.get() ?? "1";
      const amount = parseInt(amountStr, 10);
      if (!Number.isFinite(amount)) {
        return;
      }

      const current = ensureNumber(value.get());
      const next = current + amount;
      if (next === current) {
        const status = stability.get();
        const confirmations = status.stable ? status.confirmations + 1 : 1;
        stability.set({ stable: true, confirmations });
        value.set(next);
        return;
      }

      value.set(next);
      stability.set({ stable: false, confirmations: 0 });
    })({ value, stability, incrementAmount });

    const performOverride = handler<
      unknown,
      {
        value: Cell<number>;
        stability: Cell<StabilityStatus>;
        overrideValue: Cell<string>;
      }
    >((_event, { value, stability, overrideValue }) => {
      const rawStr = overrideValue.get() ?? "0";
      const raw = parseInt(rawStr, 10);
      if (!Number.isFinite(raw)) {
        return;
      }

      const current = ensureNumber(value.get());
      if (raw === current) {
        const status = stability.get();
        const confirmations = status.stable ? status.confirmations + 1 : 1;
        stability.set({ stable: true, confirmations });
        value.set(raw);
        return;
      }

      value.set(raw);
      stability.set({ stable: false, confirmations: 0 });
    })({ value, stability, overrideValue });

    const name = str`Reference Equality (v${version})`;

    const parityColor = lift((p: Parity) =>
      p === "even" ? "#10b981" : "#f59e0b"
    )(parity);

    const parityBg = lift((p: Parity) => p === "even" ? "#d1fae5" : "#fef3c7")(
      parity,
    );

    const stabilityColor = lift((status: StabilityStatus) =>
      status.stable ? "#10b981" : "#ef4444"
    )(stabilityView);

    const stabilityBg = lift((status: StabilityStatus) =>
      status.stable ? "#d1fae5" : "#fee2e2"
    )(stabilityView);

    const stabilityLabel = lift((status: StabilityStatus) =>
      status.stable ? "Stable" : "Changed"
    )(stabilityView);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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
                    color: #64748b;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Reference Equality Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  Value Stability Tracker
                </h2>
                <p style="
                    margin: 0.5rem 0 0 0;
                    color: #64748b;
                    font-size: 0.9rem;
                    line-height: 1.5;
                  ">
                  Demonstrates reference equality checks where the derived
                  summary object is only recreated when the sanitized value
                  actually changes. Repeated identical updates are detected and
                  tracked as stability confirmations.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 1rem;
                  padding: 1.5rem;
                  color: white;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 1rem;
                    flex-wrap: wrap;
                  ">
                  <div style="flex: 1; min-width: 200px;">
                    <div style="
                        font-size: 0.75rem;
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        opacity: 0.9;
                        margin-bottom: 0.5rem;
                      ">
                      Current Value
                    </div>
                    <div style="
                        font-size: 3rem;
                        font-weight: 700;
                        line-height: 1;
                      ">
                      {currentValue}
                    </div>
                  </div>
                  <div style="
                      display: flex;
                      gap: 1rem;
                      align-items: center;
                    ">
                    <div style="
                        text-align: center;
                        background: rgba(255, 255, 255, 0.2);
                        border-radius: 0.75rem;
                        padding: 0.75rem 1rem;
                      ">
                      <div style="
                          font-size: 0.7rem;
                          text-transform: uppercase;
                          letter-spacing: 0.05em;
                          opacity: 0.9;
                        ">
                        Version
                      </div>
                      <div style="
                          font-size: 1.75rem;
                          font-weight: 700;
                          margin-top: 0.25rem;
                        ">
                        {version}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
              gap: 1rem;
            ">
            <ct-card>
              <div
                slot="header"
                style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                "
              >
                <span style="
                    font-size: 1.5rem;
                  ">
                  🎯
                </span>
                <h3 style="
                    margin: 0;
                    font-size: 1.1rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Parity
                </h3>
              </div>
              <div
                slot="content"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                "
              >
                <div
                  style={lift((bg: string, color: string) =>
                    `background: ${bg}; border-radius: 0.75rem; padding: 1.5rem; text-align: center; border: 2px solid ${color};`
                  )(parityBg, parityColor)}
                >
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      margin-bottom: 0.5rem;
                    ">
                    Current Parity
                  </div>
                  <div
                    style={lift((color: string) =>
                      `font-size: 2rem; font-weight: 700; color: ${color}; line-height: 1; text-transform: uppercase;`
                    )(parityColor)}
                  >
                    {parity}
                  </div>
                </div>
                <div style="
                    background: #f8fafc;
                    border-radius: 0.5rem;
                    padding: 0.75rem;
                    font-size: 0.85rem;
                    color: #64748b;
                    text-align: center;
                  ">
                  Part of derived summary object
                </div>
              </div>
            </ct-card>

            <ct-card>
              <div
                slot="header"
                style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                "
              >
                <span style="
                    font-size: 1.5rem;
                  ">
                  🔄
                </span>
                <h3 style="
                    margin: 0;
                    font-size: 1.1rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Stability
                </h3>
              </div>
              <div
                slot="content"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                "
              >
                <div
                  style={lift((bg: string, color: string) =>
                    `background: ${bg}; border-radius: 0.75rem; padding: 1.5rem; text-align: center; border: 2px solid ${color};`
                  )(stabilityBg, stabilityColor)}
                >
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      margin-bottom: 0.5rem;
                    ">
                    Status
                  </div>
                  <div
                    style={lift((color: string) =>
                      `font-size: 2rem; font-weight: 700; color: ${color}; line-height: 1;`
                    )(stabilityColor)}
                  >
                    {stabilityLabel}
                  </div>
                </div>
                <div style="
                    background: #f8fafc;
                    border-radius: 0.5rem;
                    padding: 0.75rem;
                    font-size: 0.85rem;
                    color: #64748b;
                    text-align: center;
                  ">
                  Confirmations:{" "}
                  {lift((status: StabilityStatus) => status.confirmations)(
                    stabilityView,
                  )}
                </div>
              </div>
            </ct-card>
          </div>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="
                  font-size: 1.25rem;
                ">
                ➕
              </span>
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                Increment Value
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <p style="
                  margin: 0;
                  color: #64748b;
                  font-size: 0.9rem;
                  line-height: 1.5;
                ">
                Add to the current value. If the result equals the current value
                (e.g., adding 0), the reference stays stable and confirmations
                increase.
              </p>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  align-items: stretch;
                  flex-wrap: wrap;
                ">
                <div style="flex: 1; min-width: 150px;">
                  <label style="
                      display: block;
                      font-size: 0.8rem;
                      font-weight: 600;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Amount
                  </label>
                  <ct-input
                    type="number"
                    $value={incrementAmount}
                    style="width: 100%;"
                  />
                </div>

                <div style="
                    display: flex;
                    align-items: flex-end;
                  ">
                  <ct-button
                    variant="primary"
                    onclick={performIncrement}
                    style="
                      height: 2.5rem;
                      padding: 0 1.5rem;
                    "
                  >
                    Increment
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="
                  font-size: 1.25rem;
                ">
                🎚️
              </span>
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                Override Value
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <p style="
                  margin: 0;
                  color: #64748b;
                  font-size: 0.9rem;
                  line-height: 1.5;
                ">
                Set a specific value. If you set the same value as current, the
                reference remains stable and confirmations increase.
              </p>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  align-items: stretch;
                  flex-wrap: wrap;
                ">
                <div style="flex: 1; min-width: 150px;">
                  <label style="
                      display: block;
                      font-size: 0.8rem;
                      font-weight: 600;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    New Value
                  </label>
                  <ct-input
                    type="number"
                    $value={overrideValue}
                    style="width: 100%;"
                  />
                </div>

                <div style="
                    display: flex;
                    align-items: flex-end;
                  ">
                  <ct-button
                    variant="secondary"
                    onclick={performOverride}
                    style="
                      height: 2.5rem;
                      padding: 0 1.5rem;
                    "
                  >
                    Set Value
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                background: #eff6ff;
                border-left: 4px solid #3b82f6;
                padding: 1rem;
                border-radius: 0.5rem;
              "
            >
              <h4 style="
                  margin: 0 0 0.5rem 0;
                  color: #1e40af;
                  font-size: 0.95rem;
                  font-weight: 600;
                ">
                💡 How It Works
              </h4>
              <p style="
                  margin: 0;
                  color: #1e40af;
                  font-size: 0.85rem;
                  line-height: 1.6;
                ">
                This pattern demonstrates reference equality optimization. The
                summary object (containing value, parity, and version) is only
                recreated when the actual value changes. When you perform an
                operation that results in the same value (like adding 0 or
                setting the current value), the reference stays stable, the
                version doesn't increment, and confirmations count up. This is
                useful for avoiding unnecessary re-renders and cache
                invalidations in reactive systems.
              </p>
            </div>
          </ct-card>
        </div>
      ),
      value,
      current: currentValue,
      summary,
      parity,
      version,
      label,
      referenceStatus: stability,
      increment: applyIncrement({ value, stability }),
      override: applyOverride({ value, stability }),
    };
  },
);
