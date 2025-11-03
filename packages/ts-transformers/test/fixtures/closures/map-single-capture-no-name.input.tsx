/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

export default recipe((state: State) => {
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
