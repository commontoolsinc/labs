/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
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

const sanitizeCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const resolveAmount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.trunc(value);
};

const adjustParent = handler(
  (
    event: { amount?: number } | number | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event === "number"
      ? resolveAmount(event)
      : resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

const toggleEnabled = handler(
  (_event: unknown, context: { enabled: Cell<boolean> }) => {
    const current = context.enabled.get() === true;
    context.enabled.set(!current);
  },
);

const adjustChild = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

interface ChildCounterState {
  value: number;
  current: number;
  label: string;
  increment: { amount?: number };
}

const conditionalChild = recipe<
  { value: Default<number, 0> },
  ChildCounterState
>(
  "Conditional Child Counter",
  ({ value }) => {
    const current = lift(sanitizeCount)(value);
    const label = str`Child value ${current}`;
    return {
      value,
      current,
      label,
      increment: adjustChild({ value }),
    };
  },
);

interface ConditionalChildArgs {
  value: Default<number, 0>;
  enabled: Default<boolean, false>;
}

export const counterWithConditionalChildInstantiationUx = recipe<
  ConditionalChildArgs
>(
  "Counter With Conditional Child Instantiation (UX)",
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

    const safeValue = lift(sanitizeCount)(value);
    const isActive = lift((flag: boolean | undefined) => flag === true)(
      enabled,
    );
    const activeStatus = lift((flag: boolean) => flag ? "active" : "idle")(
      isActive,
    );
    const childSlot = cell<ChildCounterState | undefined>(undefined);
    const childGuard = lift(
      (
        state: {
          active: boolean;
          seed: number;
          snapshot: ChildCounterState | undefined;
        },
      ) => {
        const existing = childSlot.get();
        if (!state.active) {
          if (existing !== undefined) childSlot.set(undefined);
          return state.active;
        }
        if (existing === undefined) {
          childSlot.set(conditionalChild({ value: state.seed }));
        }
        return state.active;
      },
    )({ active: isActive, seed: safeValue, snapshot: childSlot });
    const childStatus = lift((active: boolean) =>
      active ? "present" : "absent"
    )(
      isActive,
    );
    const label =
      str`Parent ${safeValue} (${activeStatus}) child ${childStatus}`;
    const name = str`Conditional child instantiation (${safeValue})`;

    const toggle = toggleEnabled({ enabled });
    const increment = adjustParent({ value });

    const statusIconStyle = lift((isActive: boolean) =>
      isActive
        ? "display: inline-block; width: 0.75rem; height: 0.75rem; background: #10b981; border-radius: 50%; margin-right: 0.5rem;"
        : "display: inline-block; width: 0.75rem; height: 0.75rem; background: #64748b; border-radius: 50%; margin-right: 0.5rem;"
    )(isActive);

    const childCardStyle = lift((isActive: boolean) =>
      isActive ? "display: block;" : "display: none;"
    )(isActive);

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
                  Conditional Child Instantiation
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Toggle to dynamically create or destroy child counter
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
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <span style="font-size: 0.9rem; color: #475569;">
                    Parent value
                  </span>
                  <strong style="font-size: 2rem; color: #0f172a;">
                    {safeValue}
                  </strong>
                </div>

                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                  ">
                  <span style={statusIconStyle}></span>
                  <span style="font-weight: 600; color: #0f172a;">
                    Child status: {childStatus}
                  </span>
                </div>

                <div style="
                    display: flex;
                    gap: 0.5rem;
                  ">
                  <ct-button
                    onClick={toggle}
                    variant="secondary"
                    aria-label="Toggle child instantiation"
                    data-testid="toggle-button"
                    style="flex: 1;"
                  >
                    {lift((active: boolean) =>
                      active ? "Destroy child" : "Create child"
                    )(isActive)}
                  </ct-button>

                  <ct-button
                    onClick={increment}
                    aria-label="Increment parent"
                    data-testid="increment-parent-button"
                    style="flex: 1;"
                  >
                    Parent +1
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card style={childCardStyle} data-testid="child-card">
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Child counter instance
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
                  background: #ecfdf5;
                  border: 2px solid #10b981;
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                  align-items: center;
                  text-align: center;
                ">
                <div style="
                    font-size: 1.1rem;
                    color: #065f46;
                    font-weight: 600;
                  ">
                  ✓ Child instance active
                </div>
                <div style="
                    font-size: 0.9rem;
                    color: #065f46;
                    opacity: 0.9;
                  ">
                  A child counter recipe has been instantiated with the parent's
                  value as its initial state.
                </div>
              </div>

              <div style="
                  background: #fef3c7;
                  border-left: 3px solid #f59e0b;
                  padding: 0.75rem;
                  border-radius: 0.25rem;
                  font-size: 0.85rem;
                  color: #92400e;
                ">
                <strong>Note:</strong>{" "}
                The child counter is instantiated with the parent's value at
                creation time. Destroying and recreating will re-seed it with
                the parent's current value.
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
                This pattern demonstrates{" "}
                <strong>conditional child instantiation</strong>
                —dynamically creating or destroying a child recipe instance
                based on runtime state.
              </p>
              <p style="margin: 0;">
                When enabled, a child counter is instantiated using the parent's
                current value as its initial state. When disabled, the child is
                cleanly destroyed. This showcases lifecycle management in
                reactive systems.
              </p>
              <p style="margin: 0;">
                The{" "}
                <code style="
                    background: #f1f5f9;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  childGuard
                </code>{" "}
                lift ensures the child is only present when the toggle is
                active, and it gets re-seeded from the parent whenever
                recreated.
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
      current: safeValue,
      isActive,
      label,
      childStatus,
      child: childSlot,
      toggle,
      increment,
      effects: { childGuard, initialize },
    };
  },
);

export default counterWithConditionalChildInstantiationUx;
