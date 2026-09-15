import { pattern } from "commonfabric";

// FIXTURE: top-level-h-binding
// Verifies: a module that binds `h` at top level gets the bare `void __cfHelpers;`
//   trailer instead of the forwarding `h` shim, so the authored `h` is not a
//   duplicate identifier and JSX still dispatches through `__cfHelpers.h`
const h = ["a", "b"];
export default pattern<{ title: string }>(({ title }) => (
  <ul title={title}>{h.map((item) => <li>{item}</li>)}</ul>
));
