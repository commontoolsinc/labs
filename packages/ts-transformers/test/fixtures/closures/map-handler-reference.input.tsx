/// <cts-enable />
import { pattern, UI, handler, Cell } from "commontools";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ct-button": any;
    }
  }
}

// Event handler defined at module scope
const handleClick = handler<unknown, { count: Cell<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  count: Cell<number>;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map callback references handler - should NOT capture it */}
        {state.items.map((item) => (
          <ct-button onClick={handleClick({ count: state.count })}>
            {item.name}
          </ct-button>
        ))}
      </div>
    ),
  };
});
