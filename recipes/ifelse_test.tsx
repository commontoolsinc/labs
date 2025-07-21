/// <cts-enable />

import { Cell, Default, h, handler, NAME, recipe, UI } from "commontools";

const incCounter = handler<undefined, { counter: Cell<number> }>(
  (_, { counter }) => {
    counter.set(counter.get() + 1);
  },
);

export default recipe<{
  counter: Default<number, 0>;
}>("IfElseTest", ({ counter }) => {
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
