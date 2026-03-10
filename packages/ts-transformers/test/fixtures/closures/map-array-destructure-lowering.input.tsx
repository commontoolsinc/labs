/// <cts-enable />
import { pattern, UI } from "commontools";

type Row = [left: string, right: string];

interface State {
  rows: Row[];
}

export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.rows.map(([left, right]) => (
          <span>
            {left}:{right}
          </span>
        ))}
      </div>
    ),
  };
});
