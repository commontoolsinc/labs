/// <cts-enable />
import { Cell, Default, h, handler, recipe, UI } from "commontools";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ct-button": any;
    }
  }
}

const handleClick = handler<unknown, { count: Cell<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

export default recipe<{ count: Default<number, 0> }>(
  "Event Handler Test",
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