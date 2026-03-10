/// <cts-enable />
/**
 * Writable.of() result accessed via .get()/.set() in action
 * callbacks. These are terminal methods handled correctly regardless
 * of opaque classification — Writable.of() is an opaque origin and
 * .get()/.set() are terminal methods.
 */
import { action, pattern, UI, Writable } from "commontools";

interface State {
  title: string;
}

export default pattern<State>(({ title }) => {
  const counter = Writable.of(0);
  const label = Writable.of("Count");

  const reset = action(() => {
    counter.set(0);
    label.set("Count");
  });

  return {
    [UI]: (
      <div>
        <span>{title} {label}: {counter}</span>
        <ct-button onClick={reset}>Reset</ct-button>
      </div>
    ),
    counter,
    label,
  };
});
