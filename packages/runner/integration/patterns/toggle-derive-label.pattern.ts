/// <cts-enable />
import { Cell, derive, handler, recipe } from "commontools";

interface ToggleArgs {
  active?: boolean;
}

const toggleState = handler(
  (_event: unknown, context: { active: Cell<boolean> }) => {
    const current = context.active.get() ?? false;
    context.active.set(!current);
  },
);

export const toggleWithLabel = recipe<ToggleArgs>(
  "Toggle With Derive Label",
  ({ active }) => {
    active.setDefault(false);

    const status = derive(
      active,
      (isActive) => (isActive ? "enabled" : "disabled"),
    );

    return {
      active,
      status,
      toggle: toggleState({ active }),
    };
  },
);
