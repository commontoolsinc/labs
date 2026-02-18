/// <cts-enable />
import { when, pattern, UI, NAME } from "commontools";

interface State {
  enabled: boolean;
  message: string;
}

export default pattern<State>(({ enabled, message }) => {
  // when(condition, value) - returns value if condition is truthy, else condition
  const result = when(enabled, message);

  return {
    [NAME]: "when schema test",
    [UI]: <div>{result}</div>,
  };
});
