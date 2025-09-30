/// <cts-enable />
import { handler } from "commontools";

interface IncrementEvent {
  amount: number;
}

interface CounterState {
  count: number;
}

// Both parameters typed inline (no generic type arguments)
export const incrementer = handler((event: IncrementEvent, state: CounterState) => {
  state.count += event.amount;
});