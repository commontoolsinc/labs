import { pattern, UI } from "commonfabric";

// FIXTURE: handler-captured-callable-export-binding
// Verifies: inline JSX handlers should not route captured plain callables through
// explicit handler state. The helper should remain lexical in the callback body.
function makePattern(helper: (value: string) => string) {
  return pattern(() => {
    return {
      [UI]: <cf-button onClick={() => helper("x")}>Go</cf-button>,
    };
  });
}

const helper = (value: string) => value.toUpperCase();
const myPattern = makePattern(helper);

export default myPattern;
