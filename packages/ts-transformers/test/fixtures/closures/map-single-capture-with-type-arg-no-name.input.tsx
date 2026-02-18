/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.price * state.discount}</span>
        ))}
      </div>
    ),
  };
});