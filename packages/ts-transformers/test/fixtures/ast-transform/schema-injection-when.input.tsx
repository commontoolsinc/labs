/// <cts-enable />
import { when, recipe, UI, NAME } from "commontools";

interface State {
  enabled: boolean;
  message: string;
}

export default recipe<State>("When Schema Injection", ({ enabled, message }) => {
  // when(condition, value) - returns value if condition is truthy, else condition
  const result = when(enabled, message);

  return {
    [NAME]: "when schema test",
    [UI]: <div>{result}</div>,
  };
});
