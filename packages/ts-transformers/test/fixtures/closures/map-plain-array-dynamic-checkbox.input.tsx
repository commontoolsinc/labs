/// <cts-enable />
import { pattern, UI } from "commontools";

type SelectedScopes = {
  gmail: boolean;
  calendar: boolean;
};

const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail",
  calendar: "Calendar",
} as const;

interface Input {
  selectedScopes: SelectedScopes;
}

// FIXTURE: map-plain-array-dynamic-checkbox
// Verifies: plain-array callback roots stay plain while dynamic JSX bindings still derive
//   Object.entries(...).map(fn)                     -> plain .map() remains plain
//   selectedScopes[key as keyof SelectedScopes]     -> derived binding with selectedScopes and key captures
// Context: Dynamic property access in a plain array callback used as a ct-checkbox binding
export default pattern<Input>(({ selectedScopes }) => {
  return {
    [UI]: (
      <div>
        {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (
          <label>
            <ct-checkbox $checked={selectedScopes[key as keyof SelectedScopes]}>
              {description}
            </ct-checkbox>
          </label>
        ))}
      </div>
    ),
  };
});
