/// <cts-enable />
import { recipe, UI } from "commontools";

interface Point {
  x: number;
  y: number;
}

interface State {
  points: Point[];
  scale: number;
}

export default recipe<State>("DestructuredParam", (state) => {
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
