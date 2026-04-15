import { action } from "commonfabric";

// FIXTURE: action-captured-callable-export-binding
// Verifies: action() should not route captured plain callables through handler state
//   makeAction(helper) where helper is a closed-over callable should preserve lexical helper
//   access in the handler body instead of destructuring/passing helper through handler params.
// Context: the exported action binding form is later rejected by the plain-data/SES path, but
// this fixture isolates the earlier closure-transform shape in --show-transformed output.
function makeAction(helper: (value: string) => string) {
  return action(() => {
    return helper("x");
  });
}

const helper = (value: string) => value.toUpperCase();
const myAction = makeAction(helper);

export default myAction;
