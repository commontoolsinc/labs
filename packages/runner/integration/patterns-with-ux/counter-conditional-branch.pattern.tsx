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

interface ConditionalBranchArgs {
  value: Default<number, 0>;
  enabled: Default<boolean, false>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

export const counterWithConditionalBranchUx = recipe<ConditionalBranchArgs>(
  "Counter With Conditional Branch (UX)",
  ({ value, enabled }) => {
    const initialize = compute(() => {
      if (value.get() === undefined) {
        value.set(0);
      }
      const currentFlag = enabled.get();
      if (typeof currentFlag !== "boolean") {
        enabled.set(false);
      }
    });

    const safeValue = lift((count: number | undefined) => toInteger(count))(
      value,
    );

    const active = lift((flag: boolean | undefined) => flag === true)(enabled);

    const branch = lift((flag: boolean | undefined) =>
      flag === true ? "Enabled" : "Disabled"
    )(enabled);

    const label = str`${branch} ${safeValue}`;
    const name = str`Conditional branch counter (${safeValue})`;

    const toggle = handler<
      unknown,
      { enabled: Cell<boolean> }
    >((_event, { enabled }) => {
      const current = enabled.get() ?? false;
      enabled.set(!current);
    })({ enabled });

    const increment = handler<
      { amount?: number } | undefined,
      { value: Cell<number> }
    >((event, { value }) => {
      const amount = typeof event?.amount === "number" ? event.amount : 1;
      const next = toInteger(value.get()) + amount;
      value.set(next);
    })({ value });

    const branchStatusStyle = lift((isActive: boolean) =>
      isActive
        ? "background: linear-gradient(135deg, #10b981, #059669); color: white; border: 2px solid #059669;"
        : "background: linear-gradient(135deg, #64748b, #475569); color: white; border: 2px solid #475569;"
    )(active);

    const branchIconStyle = lift((isActive: boolean) =>
      isActive
        ? "display: inline-block; width: 0.75rem; height: 0.75rem; background: #dcfce7; border-radius: 50%; margin-right: 0.5rem;"
        : "display: inline-block; width: 0.75rem; height: 0.75rem; background: #cbd5e1; border-radius: 50%; margin-right: 0.5rem;"
    )(active);

    const incrementButtonStyle = lift((isActive: boolean) =>
      isActive
        ? "opacity: 1; cursor: pointer;"
        : "opacity: 0.5; cursor: not-allowed;"
    )(active);

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
                  Conditional Branch Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Toggle state to enable or disable incrementing
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
                    <strong style="font-size: 2rem; color: #0f172a;">
                      {safeValue}
                    </strong>
                  </div>
                </div>

                <div
                  style={branchStatusStyle}
                  data-testid="branch-status"
                  role="status"
                  aria-live="polite"
                  style="
                    padding: 1rem;
                    border-radius: 0.75rem;
                    font-weight: 600;
                    text-align: center;
                    transition: all 0.3s ease;
                  "
                >
                  <div style="
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    ">
                    <span style={branchIconStyle}></span>
                    <span>Branch: {branch}</span>
                  </div>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                  ">
                  <ct-button
                    onClick={toggle}
                    variant="secondary"
                    aria-label="Toggle enabled state"
                    data-testid="toggle-button"
                  >
                    Toggle state ({branch})
                  </ct-button>

                  <ct-button
                    onClick={increment}
                    disabled={lift((isActive: boolean) => !isActive)(active)}
                    aria-label="Increment counter"
                    data-testid="increment-button"
                  >
                    Increment (+1)
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
                This pattern demonstrates <strong>conditional branching</strong>
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
                primitive. The counter's increment button is only functional
                when the branch is enabled.
              </p>
              <p style="margin: 0;">
                The branch state determines whether the counter can be modified,
                showcasing how{" "}
                conditional logic can gate handler execution based on derived
                state.
              </p>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      enabled,
      active,
      current: safeValue,
      branch,
      label,
      toggle,
      increment,
      effects: { initialize },
    };
  },
);

export default counterWithConditionalBranchUx;
