/// <cts-enable />
import { handler, Cell } from "commontools";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: Cell<number>;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value.set(state.value.get() + event.increment);
});

export { myHandler };
