/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface ConditionalIfElseArgs {
  value: Default<number, 0>;
  visible: Default<boolean, false>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

export const counterWithConditionalIfElseUx = recipe<ConditionalIfElseArgs>(
  "Counter With Conditional If-Else (UX)",
  ({ value, visible }) => {
    const initialize = compute(() => {
      if (value.get() === undefined) {
        value.set(0);
      }
      const currentFlag = visible.get();
      if (typeof currentFlag !== "boolean") {
        visible.set(false);
      }
    });

    const safeValue = lift((count: number | undefined) => toInteger(count))(
      value,
    );

    const isVisible = lift((flag: boolean | undefined) => flag === true)(
      visible,
    );

    const branchState = lift((flag: boolean | undefined) =>
      flag === true ? "Enabled" : "Disabled"
    )(visible);

    const panelHeader = lift((flag: boolean | undefined) =>
      flag === true ? "Enabled Panel" : "Disabled Panel"
    )(visible);

    const panelVariant = lift((flag: boolean | undefined) =>
      flag === true ? "primary" : "muted"
    )(visible);

    const panelDescription = lift((flag: boolean | undefined) =>
      flag === true ? "Counter is interactive" : "Counter is hidden"
    )(visible);

    const label = str`${panelHeader} ${safeValue}`;
    const name = str`If-Else Branch Counter (${safeValue})`;
    const status = str`${branchState} (${panelVariant})`;

    const toggle = handler<
      unknown,
      { visible: Cell<boolean> }
    >((_event, { visible }) => {
      const current = visible.get() ?? false;
      visible.set(!current);
    })({ visible });

    const increment = handler<
      { amount?: number } | undefined,
      { value: Cell<number> }
    >((event, { value }) => {
      const amount = typeof event?.amount === "number" ? event.amount : 1;
      const next = toInteger(value.get()) + amount;
      value.set(next);
    })({ value });

    const panelStyle = lift((flag: boolean) => {
      const baseStyle =
        "padding: 1.5rem; border-radius: 0.75rem; transition: all 0.3s ease; text-align: center; font-weight: 600;";
      if (flag) {
        return baseStyle +
          " background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: 2px solid #2563eb; box-shadow: 0 4px 6px rgba(37, 99, 235, 0.2);";
      }
      return baseStyle +
        " background: linear-gradient(135deg, #94a3b8, #64748b); color: white; border: 2px solid #64748b; box-shadow: 0 2px 4px rgba(100, 116, 139, 0.1);";
    })(isVisible);

    const counterVisibility = lift((flag: boolean) =>
      flag ? "display: flex;" : "display: none;"
    )(isVisible);

    const iconStyle = lift((flag: boolean) => {
      const baseStyle =
        "display: inline-block; width: 0.875rem; height: 0.875rem; border-radius: 50%; margin-right: 0.5rem;";
      if (flag) {
        return baseStyle +
          " background: #dbeafe; box-shadow: 0 0 8px rgba(219, 234, 254, 0.6);";
      }
      return baseStyle + " background: #cbd5e1;";
    })(isVisible);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 32rem;
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
                  Conditional If-Else Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Toggle visibility to show or hide the counter panel
                </h2>
              </div>

              <div
                style={panelStyle}
                data-testid="panel-status"
                role="status"
                aria-live="polite"
              >
                <div style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <div style="
                      display: flex;
                      align-items: center;
                    ">
                    <span style={iconStyle}></span>
                    <span style="font-size: 1.1rem;">{panelHeader}</span>
                  </div>
                  <span style="
                      font-size: 0.875rem;
                      opacity: 0.9;
                      font-weight: 400;
                    ">
                    {panelDescription}
                  </span>
                </div>
              </div>

              <div
                style={counterVisibility}
                data-testid="counter-section"
              >
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                    width: 100%;
                  ">
                  <div style="
                      background: #f8fafc;
                      border-radius: 0.75rem;
                      padding: 1.25rem;
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
                        Current count
                      </span>
                      <strong style="font-size: 2.5rem; color: #0f172a;">
                        {safeValue}
                      </strong>
                    </div>
                  </div>

                  <ct-button
                    onClick={increment}
                    aria-label="Increment counter"
                    data-testid="increment-button"
                  >
                    Increment (+1)
                  </ct-button>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <ct-button
                  onClick={toggle}
                  variant="secondary"
                  aria-label="Toggle visibility"
                  data-testid="toggle-button"
                >
                  Toggle visibility
                </ct-button>
                <div style="
                    text-align: center;
                    font-size: 0.8rem;
                    color: #64748b;
                  ">
                  Status: {status}
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
                Pattern explanation
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                font-size: 0.9rem;
                color: #475569;
                line-height: 1.6;
              "
            >
              <p style="margin: 0;">
                This pattern demonstrates <strong>if-else branching</strong>
                {" "}
                using the{" "}
                <code style="
                    background: #f1f5f9;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  ifElse
                </code>{" "}
                primitive. The counter panel dynamically switches between two
                states, showing different UI trees based on a boolean condition.
              </p>
              <p style="margin: 0;">
                When visibility is enabled, the counter becomes interactive and
                displays with a primary style. When disabled, it switches to a
                muted style and the counter controls are hidden, demonstrating
                complete UI branch switching.
              </p>
              <p style="margin: 0;">
                The{" "}
                <code style="
                    background: #f1f5f9;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  ifElse
                </code>{" "}
                operator creates two distinct view trees with different headers,
                variants, and descriptions—each branch is a complete object with
                its own properties.
              </p>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status-label"
            style="font-size: 0.85rem; color: #475569; text-align: center;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      visible,
      safeValue,
      isVisible,
      branchState,
      panelHeader,
      panelVariant,
      panelDescription,
      label,
      status,
      toggle,
      increment,
      effects: { initialize },
    };
  },
);

export default counterWithConditionalIfElseUx;
