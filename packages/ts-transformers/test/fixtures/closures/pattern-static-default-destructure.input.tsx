/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  title: string;
  count: number;
}

// FIXTURE: pattern-static-default-destructure
// Verifies: destructured pattern params with default values become schema defaults, not runtime defaults
//   ({ title = "Untitled", count = 0 }) → (__ct_pattern_input) => { title = __ct_pattern_input.key("title"); ... }
//   default values → schema: { title: { type: "string", default: "Untitled" }, count: { type: "number", default: 0 } }
// Context: Static default values in the destructuring pattern are lifted into
//   the JSON schema as "default" annotations rather than kept as JS defaults.
export default pattern<State>(({ title = "Untitled", count = 0 }) => {
  return {
    [UI]: <div>{title}:{count}</div>,
  };
});
