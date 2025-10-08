/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

interface SharedAliasArgs {
  value: Default<number, 0>;
}

const sharedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithSharedAlias = recipe<SharedAliasArgs>(
  "Counter With Shared Alias",
  ({ value }) => {
    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);
    const label = str`Value ${safeValue}`;

    return {
      value,
      label,
      current: safeValue,
      mirrors: {
        left: safeValue,
        right: safeValue,
      },
      increment: sharedIncrement({ value }),
    };
  },
);
