/// <cts-enable />
import { handler } from "commontools";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: number;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value = state.value + event.increment;
});

export { myHandler };