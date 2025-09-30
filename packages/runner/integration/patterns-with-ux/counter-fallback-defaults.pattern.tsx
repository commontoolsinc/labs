/// <cts-enable />
import {
  Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  UI,
} from "commontools";

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

    const label = lift(
      (input: { preview: string; total: number }) =>
        "Dense values [" + input.preview + "] total " + String(input.total),
    )({ preview: densePreview, total });

    const adjustSlot = updateSlot({
      slots,
      fallback: normalizedFallback,
      expectedLength: normalizedExpected,
    });

    // UI state
    const indexFieldCell = cell<string>("");
    const amountFieldCell = cell<string>("");

    // UI handlers
    const incrementHandler = handler(
      (
        _event: unknown,
        context: {
          indexField: Cell<string>;
          amountField: Cell<string>;
          slots: Cell<(number | undefined)[]>;
          fallback: Cell<number>;
          expectedLength: Cell<number>;
        },
      ) => {
        const indexStr = context.indexField.get();
        const amountStr = context.amountField.get();

        const index = parseInt(indexStr, 10);
        if (!isFiniteNumber(index) || index < 0) return;

        const amount =
          (typeof amountStr === "string" && amountStr.trim() !== "")
            ? parseFloat(amountStr)
            : 1;
        if (!isFiniteNumber(amount)) return;

        const fallbackValue = sanitizeNumber(context.fallback.get(), 0);
        const expected = context.expectedLength.get();
        const rawSlots = context.slots.get();
        const currentLength = Array.isArray(rawSlots) ? rawSlots.length : 0;
        const requiredLength = Math.max(
          currentLength,
          expected,
          Math.floor(index) + 1,
        );
        const normalized = ensureArrayWithFallback(
          rawSlots,
          fallbackValue,
          requiredLength,
        );

        const baseValue = sanitizeNumber(
          normalized[Math.floor(index)],
          fallbackValue,
        );
        normalized[Math.floor(index)] = baseValue + amount;

        context.slots.set(normalized);
        context.indexField.set("");
        context.amountField.set("");
      },
    );

    const setHandler = handler(
      (
        _event: unknown,
        context: {
          indexField: Cell<string>;
          amountField: Cell<string>;
          slots: Cell<(number | undefined)[]>;
          fallback: Cell<number>;
          expectedLength: Cell<number>;
        },
      ) => {
        const indexStr = context.indexField.get();
        const valueStr = context.amountField.get();

        const index = parseInt(indexStr, 10);
        if (!isFiniteNumber(index) || index < 0) return;

        const value = parseFloat(valueStr);
        if (!isFiniteNumber(value)) return;

        const fallbackValue = sanitizeNumber(context.fallback.get(), 0);
        const expected = context.expectedLength.get();
        const rawSlots = context.slots.get();
        const currentLength = Array.isArray(rawSlots) ? rawSlots.length : 0;
        const requiredLength = Math.max(
          currentLength,
          expected,
          Math.floor(index) + 1,
        );
        const normalized = ensureArrayWithFallback(
          rawSlots,
          fallbackValue,
          requiredLength,
        );

        normalized[Math.floor(index)] = value;

        context.slots.set(normalized);
        context.indexField.set("");
        context.amountField.set("");
      },
    );

    const incrementAction = incrementHandler({
      indexField: indexFieldCell,
      amountField: amountFieldCell,
      slots,
      fallback: normalizedFallback,
      expectedLength: normalizedExpected,
    });

    const setAction = setHandler({
      indexField: indexFieldCell,
      amountField: amountFieldCell,
      slots,
      fallback: normalizedFallback,
      expectedLength: normalizedExpected,
    });

    // Rendered slots
    const slotsDisplay = lift((entries: number[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return h("div", {
          style:
            "padding: 16px; text-align: center; color: #64748b; font-style: italic;",
        }, "No slots yet");
      }

      const elements = [];
      for (let i = 0; i < entries.length; i++) {
        const value = entries[i];
        const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
        const borderColor = "#e2e8f0";

        elements.push(
          h(
            "div",
            {
              style:
                "display: flex; align-items: center; padding: 12px; background: " +
                bg + "; border-bottom: 1px solid " + borderColor + ";",
            },
            h("div", {
              style:
                "font-family: monospace; font-size: 14px; font-weight: 600; color: #475569; min-width: 60px;",
            }, "Slot " + String(i)),
            h("div", {
              style:
                "font-family: monospace; font-size: 20px; font-weight: 700; color: #0f172a; margin-left: auto;",
            }, String(value)),
          ),
        );
      }

      return h("div", {
        style:
          "border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;",
      }, ...elements);
    })(dense);

    const name = lift(
      (input: { preview: string; total: number }) =>
        "Fallback Defaults [" + input.preview + "] = " + String(input.total),
    )({ preview: densePreview, total });

    const ui = (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "600px",
          margin: "0 auto",
          padding: "24px",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "24px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "24px",
              fontWeight: "700",
              color: "#1e293b",
            }}
          >
            Sparse Array Counter
          </h1>
          <p
            style={{
              margin: "0 0 24px 0",
              fontSize: "14px",
              color: "#64748b",
              lineHeight: "1.5",
            }}
          >
            Demonstrates handling sparse arrays with fallback values
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginBottom: "24px",
              padding: "16px",
              background: "#f8fafc",
              borderRadius: "8px",
              border: "2px solid #e2e8f0",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "#64748b",
                  marginBottom: "4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Fallback Value
              </div>
              <div
                style={{
                  fontSize: "32px",
                  fontWeight: "700",
                  color: "#667eea",
                  fontFamily: "monospace",
                }}
              >
                {normalizedFallback}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "#64748b",
                  marginBottom: "4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Total Sum
              </div>
              <div
                style={{
                  fontSize: "32px",
                  fontWeight: "700",
                  color: "#10b981",
                  fontFamily: "monospace",
                }}
              >
                {total}
              </div>
            </div>
          </div>

          {slotsDisplay}

          <div
            style={{
              marginTop: "24px",
              padding: "20px",
              background: "#f1f5f9",
              borderRadius: "8px",
            }}
          >
            <h2
              style={{
                margin: "0 0 16px 0",
                fontSize: "16px",
                fontWeight: "600",
                color: "#334155",
              }}
            >
              Adjust Slots
            </h2>

            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#475569",
                    marginBottom: "4px",
                  }}
                >
                  Slot Index
                </label>
                <ct-input
                  $value={indexFieldCell}
                  placeholder="0"
                  style="width: 100%; padding: 10px; border: 2px solid #cbd5e1; border-radius: 6px; font-size: 14px; font-family: monospace;"
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#475569",
                    marginBottom: "4px",
                  }}
                >
                  Amount / Value
                </label>
                <ct-input
                  $value={amountFieldCell}
                  placeholder="1"
                  style="width: 100%; padding: 10px; border: 2px solid #cbd5e1; border-radius: 6px; font-size: 14px; font-family: monospace;"
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                }}
              >
                <ct-button
                  onClick={incrementAction}
                  style={{
                    padding: "12px 16px",
                    background: "#667eea",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  Increment
                </ct-button>
                <ct-button
                  onClick={setAction}
                  style={{
                    padding: "12px 16px",
                    background: "#764ba2",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  Set Value
                </ct-button>
              </div>
            </div>

            <p
              style={{
                marginTop: "12px",
                fontSize: "12px",
                color: "#64748b",
                lineHeight: "1.5",
              }}
            >
              <strong>Increment:</strong>{" "}
              Adds the amount to the slot's current value (or fallback if
              undefined).
              <br />
              <strong>Set Value:</strong>{" "}
              Sets the slot to the exact value specified.
            </p>
          </div>
        </div>
      </div>
    );

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
      [NAME]: name,
      [UI]: ui,
    };
  },
);
