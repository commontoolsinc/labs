/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: number[];
  settings: { multiplier: number };
}

export default pattern<State>((state) => {
  const settings = state.settings;
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item * settings.multiplier}</span>
        ))}
      </div>
    ),
  };
});
