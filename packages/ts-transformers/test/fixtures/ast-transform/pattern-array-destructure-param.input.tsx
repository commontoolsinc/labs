/// <cts-enable />
import { pattern } from "commontools";

// FIXTURE: pattern-array-destructure-param
// Verifies: top-level array destructuring in pattern params lowers to index-based key access
//   ([first]) => <div>{first}</div> → const first = __ct_pattern_input.key("0")
export default pattern<[string]>(([first]) => <div>{first}</div>);
