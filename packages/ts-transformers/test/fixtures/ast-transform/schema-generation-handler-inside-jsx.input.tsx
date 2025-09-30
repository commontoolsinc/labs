/// <cts-enable />
import { handler, h } from "commontools";

interface ClickEvent {
  x: number;
  y: number;
}

interface AppState {
  clicks: number;
  lastPosition: { x: number; y: number };
}

export const result = (
  <div>
    {handler((event: ClickEvent, state: AppState) => ({
      clicks: state.clicks + 1,
      lastPosition: { x: event.x, y: event.y },
    }))}
  </div>
);
