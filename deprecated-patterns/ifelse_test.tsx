/// <cts-enable />

import { Cell, Default, handler, NAME, pattern, UI } from "commontools";

const incCounter = handler<undefined, { counter: Cell<number> }>(
  (_, { counter }) => {
    counter.set(counter.get() + 1);
  },
);

export default pattern<{
  counter: Default<number, 0>;
}>(({ counter }) => {
  console.log("counter", counter);

  return {
    [NAME]: `counter: ${counter}`,
    [UI]: (
      <div>
        {counter % 2 ? <p>odd: {counter}</p> : <p>even: {counter}</p>}
        <p />
        <button type="button" onClick={incCounter({ counter })}>
          click me
        </button>
      </div>
    ),
  };
});
