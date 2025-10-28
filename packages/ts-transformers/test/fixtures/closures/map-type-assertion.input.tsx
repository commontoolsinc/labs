/// <cts-enable />
import { recipe, UI, OpaqueRef } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: any; // Type will be asserted
  prefix: string;
}

export default recipe<State>("TypeAssertion", (state) => {
  // Type assertion to OpaqueRef<Item[]>
  const typedItems = state.items as OpaqueRef<Item[]>;

  return {
    [UI]: (
      <div>
        {/* Map on type-asserted reactive array */}
        {typedItems.map((item) => (
          <div>
            {state.prefix}: {item.name}
          </div>
        ))}
      </div>
    ),
  };
});
