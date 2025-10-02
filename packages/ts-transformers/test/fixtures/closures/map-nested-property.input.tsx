/// <cts-enable />
import { h, recipe, UI } from "commontools";

interface Item {
  id: number;
  name: string;
}

interface User {
  firstName: string;
  lastName: string;
}

interface State {
  items: Item[];
  currentUser: User;
}

export default recipe<State>("NestedProperty", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <div>
            {item.name} - edited by {state.currentUser.firstName} {state.currentUser.lastName}
          </div>
        ))}
      </div>
    ),
  };
});
