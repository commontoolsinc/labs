/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  title: string;
  count: number;
}

export default pattern<State>(({ title = "Untitled", count = 0 }) => {
  return {
    [UI]: <div>{title}:{count}</div>,
  };
});
