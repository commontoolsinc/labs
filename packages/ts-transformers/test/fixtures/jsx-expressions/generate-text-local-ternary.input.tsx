import { generateTextStream, pattern, UI } from "commonfabric";

// FIXTURE: generate-text-local-ternary
// Verifies: local reactive builder results still trigger JSX ternary lowering
//   text.pending ? "Loading" : text.result -> __cfHelpers.ifElse(...)
// Context: `text` is a local `generateTextStream()` result rather than a pattern
// input binding, so this exercises expression-site lowering on local reactive
// aliases in JSX.
export default pattern(() => {
  const text = generateTextStream({ prompt: "hi" });

  return {
    [UI]: <div>{text.pending ? "Loading" : text.result}</div>,
  };
});
