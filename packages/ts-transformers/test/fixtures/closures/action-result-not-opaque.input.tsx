/// <cts-enable />
/**
 * action() results used as event handlers in JSX. action() is an
 * opaque origin but handler results are typically used directly
 * (no property access), so opaque classification doesn't affect them.
 */
import { action, pattern, UI, Writable } from "commontools";

interface State {
  label: string;
}

export default pattern<State>(({ label }) => {
  const count = Writable.of(0);

  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const decrement = action(() => {
    count.set(count.get() - 1);
  });

  return {
    [UI]: (
      <div>
        <span>{label}: {count}</span>
        <ct-button onClick={increment}>+</ct-button>
        <ct-button onClick={decrement}>-</ct-button>
      </div>
    ),
    count,
  };
});
