/// <cts-enable />
import { Cell, Default, handler, pattern, UI } from "commontools";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ct-button": any;
    }
  }
}

const handleClick = handler<unknown, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  },
);

// FIXTURE: event-handler-no-derive
// Verifies: handler invocations in JSX are NOT wrapped in derive(), while expressions are
//   count + 1 (in JSX <span>)                → __ctHelpers.derive(...schemas, { count }, ({ count }) => count + 1)
//   handleClick({ count }) (onClick attr)     → left as-is (not wrapped in derive)
//   handleClick({ count }) (inside .map())    → left as-is (not wrapped in derive)
//   pattern<{ count: Default<number, 0> }>    → pattern(fn, inputSchema, outputSchema)
// Context: Negative test ensuring handler calls in event attributes and inside .map() are not derive-wrapped
export default pattern<{ count: Default<number, 0> }>(
  ({ count }) => {
    return {
      [UI]: (
        <div>
          {/* Regular JSX expression - should be wrapped in derive */}
          <span>Count: {count + 1}</span>

          {/* Event handler with OpaqueRef - should NOT be wrapped in derive */}
          <ct-button onClick={handleClick({ count })}>
            Click me
          </ct-button>

          {/* Event handler inside map - should NOT be wrapped in derive */}
          {[1, 2, 3].map((n) => (
            <ct-button key={n} onClick={handleClick({ count })}>
              Button {n}
            </ct-button>
          ))}
        </div>
      ),
      count,
    };
  },
);
