/// <cts-enable />
import { recipe, UI } from "commontools";

interface State {
  items: Array<{ couponCode: string }>;
}

export default recipe<State>("MapDestructuredStringAlias", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ couponCode: code }) => (
          <span>{code}</span>
        ))}
      </div>
    ),
  };
});
