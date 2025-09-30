/// <cts-enable />
import { handler } from "commontools";

interface IncrementEvent {
  amount: number;
}

// Only event is typed, state should get unknown schema
export const incrementer = handler((event: IncrementEvent, state) => {
  console.log("increment by", event.amount);
});