/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
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

interface ToggleArgs {
  active: Default<boolean, false>;
}

const toggleState = handler(
  (_event: unknown, context: { active: Cell<boolean> }) => {
    const current = context.active.get() ?? false;
    context.active.set(!current);
  },
);

export const toggleWithLabelUx = recipe<ToggleArgs>(
  "Toggle With Derive Label (UX)",
  ({ active }) => {
    const status = derive(
      active,
      (isActive) => (isActive ? "enabled" : "disabled"),
    );

    const toggle = toggleState({ active });

    const name = str`Toggle (${status})`;

    const statusColor = lift((state: string) => {
      return state === "enabled" ? "#10b981" : "#64748b";
    })(status);

    const statusBg = lift((state: string) => {
      return state === "enabled"
        ? "linear-gradient(135deg, #d1fae5, #a7f3d0)"
        : "linear-gradient(135deg, #f1f5f9, #e2e8f0)";
    })(status);

    const buttonLabel = lift((state: string) => {
      return state === "enabled" ? "Disable" : "Enable";
    })(status);

    const indicatorStyle = lift((state: string) => {
      const color = state === "enabled" ? "#10b981" : "#94a3b8";
      return "display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: " +
        color + "; margin-right: 8px; transition: background 0.3s ease;";
    })(status);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 28rem;
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
                  Toggle With Derive Label
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Toggle state with derived status label
                </h2>
              </div>

              <div
                style={lift(
                  (bg: string) =>
                    "background: " + bg +
                    "; border-radius: 0.75rem; padding: 1.5rem; display: flex; flex-direction: column; align-items: center; gap: 1rem; transition: background 0.3s ease;",
                )(statusBg)}
              >
                <div style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                  ">
                  <span style={indicatorStyle}></span>
                  <span
                    style={lift(
                      (color: string) =>
                        "font-size: 1.5rem; font-weight: 600; color: " + color +
                        "; text-transform: uppercase; letter-spacing: 0.05em; transition: color 0.3s ease;",
                    )(statusColor)}
                  >
                    {status}
                  </span>
                </div>

                <ct-button
                  onClick={toggle}
                  style="min-width: 8rem;"
                  aria-label="Toggle state"
                >
                  {buttonLabel}
                </ct-button>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.85rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                This demonstrates a simple toggle with a derived status label.
                The{" "}
                <code style="
                    background: #e2e8f0;
                    padding: 0.1rem 0.3rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  status
                </code>{" "}
                is automatically derived from the{" "}
                <code style="
                    background: #e2e8f0;
                    padding: 0.1rem 0.3rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  active
                </code>{" "}
                boolean value.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      active,
      status,
      toggle,
    };
  },
);

export default toggleWithLabelUx;
