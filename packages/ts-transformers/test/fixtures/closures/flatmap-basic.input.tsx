/// <cts-enable />
import { pattern, UI } from "commontools";

interface Group {
  name: string;
  members: string[];
}

interface State {
  groups: Group[];
}

// FIXTURE: flatmap-basic
// Verifies: .flatMap() and .map() on reactive arrays are both transformed
//   .flatMap(fn) → .flatMapWithPattern(pattern(...), {})
//   .map(fn)     → .mapWithPattern(pattern(...), {})
// Context: flatMap expands each group into its members array, then map
//   renders each. No captured outer variables — params objects are empty {}
export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.groups.flatMap((group) => group.members).map((member) => (
          <li>{member}</li>
        ))}
      </ul>
    ),
  };
});
