/**
 * Fixture: a step with no `action` / `assertion` / `settle` key. The runner must
 * reject it; the error surfaces as a file-level error on the run result.
 */
import { pattern } from "commonfabric";

export default pattern(() => {
  return {
    tests: [{}],
  };
});
