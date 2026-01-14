/// <cts-enable />
import { handler, Cell } from "commontools";

interface TimedEvent {
  timestamp: Date;
}

interface TimedState {
  lastUpdate: Cell<Date>;
}

const timedHandler = handler<TimedEvent, TimedState>((event, state) => {
  state.lastUpdate.set(event.timestamp);
});

export { timedHandler };
