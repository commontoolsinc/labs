/// <cts-enable />
import { pattern, UI } from "commontools";

interface Point {
  x: number;
  y: number;
}

interface State {
  points: Point[];
  scale: number;
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map with destructured parameter and capture */}
        {state.points.map(({ x, y }) => (
          <div>
            Point: ({x * state.scale}, {y * state.scale})
          </div>
        ))}
      </div>
    ),
  };
});
