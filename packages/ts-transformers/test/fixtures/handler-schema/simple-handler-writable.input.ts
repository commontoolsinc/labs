/// <cts-enable />
import { handler, Writable } from "commontools";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: Writable<number>;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value.set(state.value.get() + event.increment);
});

export { myHandler };
