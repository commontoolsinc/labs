/// <cts-enable />
import { pattern, UI } from "commonfabric";

let keyCounter = 0;
function nextKey() {
  return `value-${keyCounter++}`;
}

interface State {
  items: Array<Record<string, number>>;
}

// FIXTURE: map-computed-alias-side-effect
// Verifies: computed property key with side effects is hoisted and used via derive()
//   { [nextKey()]: amount } → __cf_amount_key = nextKey(); derive(...element[__cf_amount_key])
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: nextKey() has side effects (keyCounter++), so the key expression is evaluated once and cached
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [nextKey()]: amount }) => (
          <span>{amount}</span>
        ))}
      </div>
    ),
  };
});
