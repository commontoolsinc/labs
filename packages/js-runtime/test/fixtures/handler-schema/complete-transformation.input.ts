/// <cts-enable />
import { handler } from "commontools";

interface Event {
  detail: {
    value: number;
  };
}

interface State {
  value: number;
}

const increment = handler<Event, State>((_, state) => {
  state.value = state.value + 1;
});