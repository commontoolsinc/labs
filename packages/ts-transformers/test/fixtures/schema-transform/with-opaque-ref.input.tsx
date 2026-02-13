/// <cts-enable />
import { Cell, derive, pattern, toSchema, UI } from "commontools";

interface State {
  value: Cell<number>;
}

const model = toSchema<State>({
  "default": { value: 0 },
});

export default pattern(model, model, (cell) => {
  const doubled = derive(cell.value, (v) => v * 2);

  return {
    [UI]: (
      <div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>
    ),
    value: cell.value,
  };
});
