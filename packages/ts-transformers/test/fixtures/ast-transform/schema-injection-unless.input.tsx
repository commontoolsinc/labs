/// <cts-enable />
import { unless, pattern, UI, NAME } from "commontools";

interface State {
  value: string | null;
  defaultValue: string;
}

export default pattern<State>(({ value, defaultValue }) => {
  // unless(condition, fallback) - returns condition if truthy, else fallback
  const result = unless(value, defaultValue);

  return {
    [NAME]: "unless schema test",
    [UI]: <div>{result}</div>,
  };
});
