/// <cts-enable />
import { Cell, cell, Default, handler, lift, recipe, str } from "commontools";

interface RenderTreeArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface AdjustContext {
  value: Cell<number>;
  step: Cell<number>;
  direction: Cell<number>;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustContext,
  ) => {
    const direction = context.direction.get() ?? 1;
    const stepValue = context.step.get();
    const fallback = typeof stepValue === "number" && stepValue !== 0
      ? stepValue
      : 1;
    const amount = typeof event?.amount === "number" ? event.amount : fallback;
    const current = context.value.get() ?? 0;
    context.value.set(current + direction * amount);
  },
);

const normalizeNumber = (input: number | undefined, fallback: number) => {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
};

export const counterWithRenderTree = recipe<RenderTreeArgs>(
  "Counter With Render Tree",
  ({ value, step }) => {
    const safeStep = lift((raw: number | undefined) => normalizeNumber(raw, 1))(
      step,
    );
    const safeValue = lift((raw: number | undefined) =>
      normalizeNumber(raw, 0)
    )(value);

    const increment = adjustValue({
      value,
      step: safeStep,
      direction: cell(1),
    });
    const decrement = adjustValue({
      value,
      step: safeStep,
      direction: cell(-1),
    });

    const heading = str`Value ${safeValue}`;
    const description = str`Step size ${safeStep}`;
    const incrementLabel = str`Add ${safeStep}`;
    const decrementLabel = str`Subtract ${safeStep}`;

    const renderTree = {
      type: "counter-view",
      header: { text: heading },
      body: {
        description,
        controls: {
          increase: {
            kind: "button",
            label: incrementLabel,
            onPress: increment,
          },
          decrease: {
            kind: "button",
            label: decrementLabel,
            onPress: decrement,
          },
        },
      },
    };

    return {
      value,
      rawStep: step,
      step: safeStep,
      safeValue,
      heading,
      renderTree,
    };
  },
);
