/// <cts-enable />
import { Cell, handler, recipe } from "commontools";

// Updated 2025-09-03: String literal unions now generate correct JSON Schema
// (enum instead of array) due to schema-generator UnionFormatter improvements
interface UserEvent {
  user: {
    name: string;
    email: string;
    age?: number;
  };
  action: "create" | "update" | "delete";
}

interface UserState {
  users: Cell<
    Array<{
      id: string;
      name: string;
      email: string;
    }>
  >;
  lastAction: Cell<string>;
  count: Cell<number>;
}

const userHandler = handler<UserEvent, UserState>((event, state) => {
  if (event.action === "create") {
    state.users.push({
      id: Date.now().toString(),
      name: event.user.name,
      email: event.user.email,
    });
    state.count.set(state.count.get() + 1);
  }
  state.lastAction.set(event.action);
});

const _updateTags = handler<
  { detail: { tags: string[] } },
  { tags: Cell<string[]> }
>(
  ({ detail }, state) => {
    state.tags.set(detail?.tags ?? []);
  },
);

export { userHandler };

export default recipe("complex-nested-types test", () => {
  return { userHandler };
});
