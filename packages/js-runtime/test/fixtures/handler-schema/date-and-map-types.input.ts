/// <cts-enable />
import { handler } from "commontools";

interface TimedEvent {
  timestamp: Date;
  data: Map<string, number>;
}

interface TimedState {
  lastUpdate: Date;
  history: Map<string, Date>;
}

const timedHandler = handler<TimedEvent, TimedState>((event, state) => {
  state.lastUpdate = event.timestamp;
  event.data.forEach((value, key) => {
    state.history.set(key, new Date());
  });
});

export { timedHandler };