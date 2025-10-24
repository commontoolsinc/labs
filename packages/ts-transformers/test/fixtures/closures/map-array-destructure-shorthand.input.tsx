/// <cts-enable />
import { recipe, UI } from "commontools";

type ItemTuple = [item: string, count: number];

interface State {
  items: ItemTuple[];
}

export default recipe<State>("ArrayDestructureShorthand", ({ items }) => {
  return {
    [UI]: (
      <div>
        {/* Array destructured parameter - without fix, 'item' would be
            incorrectly captured in params due to shorthand usage in JSX */}
        {items.map(([item]) => (
          <div data-item={item}>{item}</div>
        ))}

        {/* Multiple array destructured params */}
        {items.map(([item, count]) => (
          <div key={item}>
            {item}: {count}
          </div>
        ))}
      </div>
    ),
  };
});
