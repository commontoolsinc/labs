/// <cts-enable />
/**
 * Block-style map callback with captured outer value.
 *
 * This is the block-style equivalent of map-single-capture.input.tsx.
 * Currently fails at runtime because statements in block callbacks
 * aren't wrapped in derives like expression callbacks are.
 */
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => {
          const discounted = item.price * state.discount;
          return <span>{discounted}</span>;
        })}
      </div>
    ),
  };
});
