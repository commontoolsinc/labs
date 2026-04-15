import { pattern, UI } from "commonfabric";

interface Input {
  items: string[];
}

// FIXTURE: map-captured-callable-export-binding
// Verifies: array-method callback lowering should not route captured plain
// callables through callback params/state. The helper should remain lexical.
function makePattern(helper: (value: string) => string) {
  return pattern<Input>(({ items }) => {
    return {
      [UI]: (
        <div>
          {items.map((item) => <span>{helper(item)}</span>)}
        </div>
      ),
    };
  });
}

const helper = (value: string) => value.toUpperCase();
const myPattern = makePattern(helper);

export default myPattern;
