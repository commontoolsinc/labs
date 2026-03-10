/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: number[];
  settings: { multiplier: number };
}

// FIXTURE: map-capture-derived-from-param
// Verifies: variable derived from state (const settings = state.settings) is captured correctly
//   .map(fn) → .mapWithPattern(pattern(...), { settings: { multiplier: settings.key("multiplier") } })
//   item * settings.multiplier → derive() with both element and captured param inputs
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
