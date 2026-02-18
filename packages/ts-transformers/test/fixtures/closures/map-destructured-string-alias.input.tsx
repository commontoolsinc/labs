/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: Array<{ couponCode: string }>;
}

export default pattern<State>((state) => {
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
