/// <cts-enable />
import { recipe, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  offset: number;
}

export default recipe<State>("IndexParam", (state) => {
  return {
    [UI]: (
      <div>
        {/* Uses both index parameter and captures state.offset */}
        {state.items.map((item, index) => (
          <div>
            Item #{index + state.offset}: {item.name}
          </div>
        ))}
      </div>
    ),
  };
});
