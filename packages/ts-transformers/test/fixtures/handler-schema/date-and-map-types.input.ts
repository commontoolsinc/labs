/// <cts-enable />
import { handler, Cell } from "commontools";

interface TimedEvent {
  timestamp: Date;
  data: Map<string, number>;
}

interface TimedState {
  lastUpdate: Cell<Date>;
  history: Cell<Map<string, Date>>;
}

const timedHandler = handler<TimedEvent, TimedState>((event, state) => {
  state.lastUpdate.set(event.timestamp);
  event.data.forEach((_value, key) => {
    state.history.get().set(key, new Date());
  });
});

export { timedHandler };
