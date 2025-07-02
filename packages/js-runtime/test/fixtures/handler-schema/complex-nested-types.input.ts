/// <cts-enable />
import { handler, Cell } from "commontools";

interface UserEvent {
  user: {
    name: string;
    email: string;
    age?: number;
  };
  action: "create" | "update" | "delete";
}

interface UserState {
  users: Array<{
    id: string;
    name: string;
    email: string;
  }>;
  lastAction: string;
  count: Cell<number>;
}

const userHandler = handler<UserEvent, UserState>((event, state) => {
  if (event.action === "create") {
    state.users.push({
      id: Date.now().toString(),
      name: event.user.name,
      email: event.user.email
    });
    state.count.set(state.count.get() + 1);
  }
  state.lastAction = event.action;
});

export { userHandler };