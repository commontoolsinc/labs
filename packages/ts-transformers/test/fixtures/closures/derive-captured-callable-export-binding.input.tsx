import { derive, pattern } from "commonfabric";

// FIXTURE: derive-captured-callable-export-binding
// Verifies: derive() should treat captured plain callables like no explicit
// captures and leave the helper lexical rather than merging it into the derive input.
function makePattern(helper: (value: string) => string) {
  return pattern(() => {
    return {
      label: derive("x", () => helper("x")),
    };
  });
}

const helper = (value: string) => value.toUpperCase();
const myPattern = makePattern(helper);

export default myPattern;
