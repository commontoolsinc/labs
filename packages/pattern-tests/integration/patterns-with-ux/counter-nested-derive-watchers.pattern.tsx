/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
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

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${sanitizeNumber(safe, 0)}`;
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

export const counterWithNestedDeriveWatchersUx = recipe<NestedDeriveArgs>(
  "Counter With Nested Derive Watchers (UX)",
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

    const currentDisplay = derive(current, (val) => formatNumber(val));
    const magnitudeDisplay = derive(magnitude, (val) => formatNumber(val));
    const parityCodeDisplay = derive(parityCode, (val) => formatNumber(val));

    const adjustField = cell<string>("1");
    const setValueField = cell<string>("0");

    const adjustCandidate = derive(adjustField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return sanitizeNumber(parsed, 1);
    });

    const setValueCandidate = derive(setValueField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 0;
      }
      return sanitizeNumber(parsed, 0);
    });

    const applyAdjust = handler<
      unknown,
      {
        value: Cell<number>;
        amount: Cell<number>;
      }
    >((_event, { value, amount }) => {
      const base = sanitizeNumber(value.get(), 0);
      const delta = sanitizeNumber(amount.get(), 1);
      value.set(base + delta);
    })({ value, amount: adjustCandidate });

    const applySetValue = handler<
      unknown,
      {
        value: Cell<number>;
        target: Cell<number>;
      }
    >((_event, { value, target }) => {
      const next = sanitizeNumber(target.get(), 0);
      value.set(next);
    })({ value, target: setValueCandidate });

    const syncAdjustField = compute(() => {
      const text = formatNumber(adjustCandidate.get());
      if (adjustField.get() !== text) {
        adjustField.set(text);
      }
    });

    const syncSetValueField = compute(() => {
      const text = formatNumber(current.get());
      if (setValueField.get() !== text) {
        setValueField.set(text);
      }
    });

    const name = str`Nested derive watchers (${currentDisplay})`;
    const status =
      str`Value ${currentDisplay} • Magnitude ${magnitudeDisplay} • Parity ${parity} • Emphasis ${emphasis}`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 36rem;
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
                  Nested derive watchers
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Watch derived values flow through nested transforms
                </h2>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <div style="
                      display: flex;
                      justify-content: space-between;
                      align-items: baseline;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Current value
                    </span>
                    <strong
                      data-testid="current-value"
                      style="font-size: 2rem; color: #0f172a;"
                    >
                      {currentDisplay}
                    </strong>
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 0.75rem;
                  ">
                  <div style="
                      background: #ecfdf5;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="font-size: 0.75rem; color: #047857;">
                      Magnitude
                    </span>
                    <strong
                      data-testid="magnitude"
                      style="font-size: 1.5rem; color: #065f46;"
                    >
                      {magnitudeDisplay}
                    </strong>
                  </div>
                  <div style="
                      background: #fef3c7;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="font-size: 0.75rem; color: #92400e;">
                      Parity
                    </span>
                    <strong
                      data-testid="parity"
                      style="font-size: 1.2rem; color: #78350f;"
                    >
                      {parity}
                    </strong>
                  </div>
                  <div style="
                      background: #ede9fe;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="font-size: 0.75rem; color: #5b21b6;">
                      Emphasis
                    </span>
                    <strong
                      data-testid="emphasis"
                      style="font-size: 1.2rem; color: #4c1d95;"
                    >
                      {emphasis}
                    </strong>
                  </div>
                </div>

                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 1rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.1rem;
                    ">
                    <span style="font-size: 0.75rem; color: #64748b;">
                      Parity code
                    </span>
                    <strong
                      data-testid="parity-code"
                      style="font-size: 1.1rem; color: #1e293b;"
                    >
                      {parityCodeDisplay}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.1rem;
                      flex: 1;
                      align-items: flex-end;
                    ">
                    <span style="font-size: 0.75rem; color: #64748b;">
                      Computed detail
                    </span>
                    <strong
                      data-testid="parity-detail"
                      style="font-size: 1.1rem; color: #1e293b;"
                    >
                      {parityDetail}
                    </strong>
                  </div>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                  ">
                  <div style="
                      display: grid;
                      grid-template-columns: 1fr auto;
                      gap: 0.75rem;
                      align-items: flex-end;
                    ">
                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.4rem;
                      ">
                      <label
                        for="adjust-amount"
                        style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                        "
                      >
                        Adjustment amount
                      </label>
                      <ct-input
                        id="adjust-amount"
                        type="number"
                        step="1"
                        $value={adjustField}
                        aria-label="Enter amount to adjust"
                      >
                      </ct-input>
                    </div>
                    <ct-button onClick={applyAdjust}>
                      Adjust by {adjustCandidate}
                    </ct-button>
                  </div>

                  <div style="
                      border-top: 1px solid #e2e8f0;
                      padding-top: 0.75rem;
                      display: grid;
                      grid-template-columns: 1fr auto;
                      gap: 0.75rem;
                      align-items: flex-end;
                    ">
                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.4rem;
                      ">
                      <label
                        for="set-value"
                        style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                        "
                      >
                        Set value directly
                      </label>
                      <ct-input
                        id="set-value"
                        type="number"
                        step="1"
                        $value={setValueField}
                        aria-label="Enter value to set"
                      >
                      </ct-input>
                    </div>
                    <ct-button variant="secondary" onClick={applySetValue}>
                      Set to {setValueCandidate}
                    </ct-button>
                  </div>
                </div>
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
                Derive chain explanation
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                  padding: 0.5rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                ">
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  value
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  current
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  magnitude
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  parity
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  emphasis
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  parityCode
                </span>
              </div>
              <div style="
                  font-size: 0.85rem;
                  color: #64748b;
                  line-height: 1.5;
                ">
                <p style="margin: 0 0 0.5rem 0;">
                  Each derive watches its upstream dependency and recomputes
                  when changes occur. This creates a reactive chain where
                  updating the value automatically propagates through all
                  derived layers.
                </p>
                <p style="margin: 0;">
                  <strong style="color: #334155;">Try it:</strong>{" "}
                  Adjust the value and watch all derived fields update
                  instantly.
                </p>
              </div>
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
      value,
      current,
      magnitude,
      parity,
      emphasis,
      parityCode,
      parityDetail,
      summary,
      currentDisplay,
      magnitudeDisplay,
      parityCodeDisplay,
      name,
      status,
      inputs: {
        adjustField,
        setValueField,
        adjustCandidate,
        setValueCandidate,
      },
      controls: {
        increment: adjustValue({ value }),
        setValue: setValue({ value }),
        applyAdjust,
        applySetValue,
      },
      effects: {
        syncAdjustField,
        syncSetValueField,
      },
    };
  },
);

export default counterWithNestedDeriveWatchersUx;
