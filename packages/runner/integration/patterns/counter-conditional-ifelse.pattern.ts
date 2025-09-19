/// <cts-enable />
import {
  type Cell,
  Default,
  handler,
  ifElse,
  lift,
  recipe,
  str,
} from "commontools";

interface ConditionalIfElseArgs {
  value: Default<number, 0>;
  visible: Default<boolean, false>;
}

interface BranchNode {
  kind: "enabled" | "disabled";
  tree: {
    header: string;
    variant: "primary" | "muted";
    description: string;
  };
}

const toggleVisibility = handler(
  (_event: unknown, context: { visible: Cell<boolean> }) => {
    const current = context.visible.get() ?? false;
    context.visible.set(!current);
  },
);

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

export const counterWithConditionalUiBranch = recipe<ConditionalIfElseArgs>(
  "Counter With Conditional UI Branch",
  ({ value, visible }) => {
    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);
    const isVisible = lift((flag: boolean | undefined) => flag === true)(
      visible,
    );

    const branchTree = ifElse<
      boolean,
      BranchNode,
      BranchNode
    >(isVisible, {
      kind: "enabled" as const,
      tree: {
        header: "Enabled Panel",
        variant: "primary" as const,
        description: "Counter is interactive",
      },
    }, {
      kind: "disabled" as const,
      tree: {
        header: "Disabled Panel",
        variant: "muted" as const,
        description: "Counter is hidden",
      },
    });

    const branchKind = lift((node: BranchNode) => node.kind)(branchTree);
    const branchHeader = lift((node: BranchNode) => node.tree.header)(
      branchTree,
    );
    const branchVariant = lift((node: BranchNode) => node.tree.variant)(
      branchTree,
    );
    const branchDescription = lift((node: BranchNode) => node.tree.description)(
      branchTree,
    );

    const label = str`${branchHeader} ${safeValue}`;
    const status = str`${branchKind} (${branchVariant})`;

    return {
      value,
      visible,
      safeValue,
      isVisible,
      branchKind,
      branchHeader,
      branchVariant,
      branchDescription,
      label,
      status,
      view: branchTree,
      toggle: toggleVisibility({ visible }),
      increment: adjustValue({ value }),
    };
  },
);
