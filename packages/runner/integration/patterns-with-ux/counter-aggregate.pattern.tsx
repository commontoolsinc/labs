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

interface AggregatorArgs {
  counters: Default<number[], []>;
}

const adjustCounter = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: { counters: Cell<number[]> },
  ) => {
    const index = event?.index ?? 0;
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target = context.counters.key(index) as Cell<number>;
    const current = target.get() ?? 0;
    target.set(current + amount);
  },
);

export const counterAggregatorUx = recipe<AggregatorArgs>(
  "Counter Aggregator (UX)",
  ({ counters }) => {
    const total = lift((values: number[]) =>
      values.reduce((sum, value) => sum + value, 0)
    )(counters);
    const count = lift((values: number[]) => values.length)(counters);
    const summary = str`Total ${total} across ${count}`;

    // UI state cells
    const indexField = cell<string>("");
    const amountField = cell<string>("");

    // UI handler to adjust a counter
    const adjustCounterUI = handler(
      (
        _event: unknown,
        context: {
          counters: Cell<number[]>;
          indexField: Cell<string>;
          amountField: Cell<string>;
        },
      ) => {
        const indexStr = context.indexField.get();
        const amountStr = context.amountField.get();

        if (
          typeof indexStr !== "string" ||
          indexStr.trim() === "" ||
          typeof amountStr !== "string" ||
          amountStr.trim() === ""
        ) {
          return;
        }

        const index = Number(indexStr);
        const amount = Number(amountStr);

        if (!Number.isFinite(index) || !Number.isFinite(amount)) {
          return;
        }

        const target = context.counters.key(Math.floor(index)) as Cell<number>;
        const current = target.get() ?? 0;
        target.set(current + amount);

        context.indexField.set("");
        context.amountField.set("");
      },
    );

    // UI handler to add a new counter
    const addCounterUI = handler(
      (
        _event: unknown,
        context: {
          counters: Cell<number[]>;
        },
      ) => {
        const current = context.counters.get() ?? [];
        context.counters.set([...current, 0]);
      },
    );

    const adjustBound = adjustCounterUI({
      counters,
      indexField,
      amountField,
    });

    const addBound = addCounterUI({ counters });

    const name = str`Aggregator: ${total}`;

    const countersDisplay = lift((inputs: {
      values: number[];
      totalSum: number;
      counterCount: number;
    }) => {
      const values = inputs.values;
      const totalSum = inputs.totalSum;
      const counterCount = inputs.counterCount;

      const counterElements = [];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        const percent = totalSum === 0
          ? 0
          : Math.round((value / totalSum) * 100);

        const card = h(
          "div",
          {
            style: "background: white; border: 2px solid #3b82f6; " +
              "border-radius: 12px; padding: 16px; " +
              "display: flex; flex-direction: column; gap: 8px;",
          },
          h(
            "div",
            {
              style: "display: flex; justify-content: space-between; " +
                "align-items: center;",
            },
            h(
              "span",
              {
                style: "font-size: 13px; color: #64748b; " +
                  "font-family: monospace; font-weight: 600;",
              },
              "Counter " + String(i),
            ),
            h(
              "span",
              {
                style: "font-size: 32px; font-weight: 800; color: #1e293b; " +
                  "font-family: monospace;",
              },
              String(value),
            ),
          ),
          h(
            "div",
            {
              style: "background: #f1f5f9; border-radius: 4px; height: 8px; " +
                "overflow: hidden;",
            },
            h("div", {
              style: "background: linear-gradient(90deg, #3b82f6, #8b5cf6); " +
                "height: 100%; width: " +
                String(percent) +
                "%; transition: width 0.3s ease;",
            }),
          ),
          h(
            "span",
            {
              style: "font-size: 12px; color: #64748b; text-align: right;",
            },
            String(percent) + "% of total",
          ),
        );
        counterElements.push(card);
      }

      const emptyState = values.length === 0
        ? h(
          "div",
          {
            style: "background: white; border: 2px dashed #cbd5e1; " +
              "border-radius: 12px; padding: 32px; text-align: center;",
          },
          h(
            "p",
            { style: "color: #94a3b8; font-size: 16px; margin: 0;" },
            "No counters yet. Add one to get started!",
          ),
        )
        : null;

      return h(
        "div",
        {
          style: "font-family: -apple-system, BlinkMacSystemFont, " +
            "'Segoe UI', Roboto, sans-serif; max-width: 900px; " +
            "margin: 0 auto; padding: 20px; " +
            "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); " +
            "min-height: 100vh;",
        },
        h(
          "div",
          {
            style: "background: white; border-radius: 16px; padding: 24px; " +
              "box-shadow: 0 10px 40px rgba(0,0,0,0.1); margin-bottom: 20px;",
          },
          h(
            "h1",
            {
              style: "margin: 0 0 8px 0; font-size: 28px; color: #1e293b; " +
                "font-weight: 700;",
            },
            "Counter Aggregator",
          ),
          h(
            "p",
            {
              style: "margin: 0 0 24px 0; color: #64748b; font-size: 14px;",
            },
            "Manage multiple counters and see their aggregate statistics",
          ),
          h(
            "div",
            {
              style: "background: linear-gradient(135deg, #3b82f6 0%, " +
                "#8b5cf6 100%); border-radius: 12px; padding: 24px; " +
                "margin-bottom: 24px;",
            },
            h(
              "div",
              {
                style: "font-size: 56px; font-weight: 900; color: white; " +
                  "text-align: center; margin-bottom: 16px; " +
                  "font-family: monospace;",
              },
              String(totalSum),
            ),
            h(
              "div",
              {
                style: "text-align: center; color: white; font-size: 16px; " +
                  "opacity: 0.95; font-weight: 500;",
              },
              "Total across " + String(counterCount) + " counter" +
                (counterCount === 1 ? "" : "s"),
            ),
          ),
          h(
            "div",
            {
              style: "display: grid; grid-template-columns: repeat(2, 1fr); " +
                "gap: 16px; margin-bottom: 24px;",
            },
            h(
              "div",
              {
                style: "background: #f8fafc; border-radius: 8px; " +
                  "padding: 16px; border: 2px solid #e2e8f0;",
              },
              h(
                "div",
                {
                  style: "font-size: 13px; color: #64748b; " +
                    "margin-bottom: 4px; font-weight: 600;",
                },
                "COUNTERS",
              ),
              h(
                "div",
                {
                  style: "font-size: 28px; font-weight: 800; color: #1e293b; " +
                    "font-family: monospace;",
                },
                String(counterCount),
              ),
            ),
            h(
              "div",
              {
                style: "background: #f8fafc; border-radius: 8px; " +
                  "padding: 16px; border: 2px solid #e2e8f0;",
              },
              h(
                "div",
                {
                  style: "font-size: 13px; color: #64748b; " +
                    "margin-bottom: 4px; font-weight: 600;",
                },
                "AVERAGE",
              ),
              h(
                "div",
                {
                  style: "font-size: 28px; font-weight: 800; color: #1e293b; " +
                    "font-family: monospace;",
                },
                counterCount === 0
                  ? "0"
                  : String((totalSum / counterCount).toFixed(1)),
              ),
            ),
          ),
          h(
            "h2",
            {
              style: "font-size: 20px; color: #1e293b; margin: 0 0 16px 0; " +
                "font-weight: 600;",
            },
            "Counters",
          ),
          emptyState === null
            ? h(
              "div",
              {
                style: "display: grid; " +
                  "grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); " +
                  "gap: 16px;",
              },
              ...counterElements,
            )
            : emptyState,
        ),
      );
    })({
      values: counters,
      totalSum: total,
      counterCount: count,
    });

    const ui = (
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          maxWidth: "900px",
          margin: "0 auto",
          padding: "20px",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        {countersDisplay}
        <div
          style={{
            background: "white",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            marginTop: "20px",
          }}
        >
          <h3
            style={{
              margin: "0 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
            }}
          >
            Add Counter
          </h3>
          <ct-button
            onClick={addBound}
            style={{
              width: "100%",
              padding: "14px",
              background: "#10b981",
              color: "white",
              border: "none",
              borderRadius: "8px",
              fontWeight: "600",
              cursor: "pointer",
              fontSize: "15px",
              marginBottom: "24px",
            }}
          >
            + Add New Counter
          </ct-button>

          <h3
            style={{
              margin: "24px 0 16px 0",
              fontSize: "18px",
              color: "#1e293b",
              fontWeight: "600",
              paddingTop: "24px",
              borderTop: "2px solid #e2e8f0",
            }}
          >
            Adjust Counter
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Counter Index
              </label>
              <ct-input
                $value={indexField}
                placeholder="e.g., 0, 1, 2"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontWeight: "600",
                  color: "#475569",
                  fontSize: "13px",
                }}
              >
                Amount to Add
              </label>
              <ct-input
                $value={amountField}
                placeholder="e.g., 5 or -3"
                style={{
                  width: "100%",
                  padding: "10px",
                  border: "2px solid #e2e8f0",
                  borderRadius: "8px",
                  fontSize: "14px",
                }}
              />
            </div>
            <ct-button
              onClick={adjustBound}
              style={{
                width: "100%",
                padding: "12px",
                background: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              Adjust Counter
            </ct-button>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      counters,
      total,
      count,
      summary,
      adjust: adjustCounter({ counters }),
    };
  },
);
