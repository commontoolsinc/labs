/// <cts-enable />
import { pattern, UI } from "commontools";

function helper(x: number) {
  return x * 2;
}

export default pattern<{ value: number }>(({ value }) => {
  return {
    [UI]: <div>{helper(value)}</div>,
  };
});
