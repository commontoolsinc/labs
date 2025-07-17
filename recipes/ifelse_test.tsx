/// <cts-enable />

import {
  Cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const incCounter = handler<undefined, { counter: Cell<number> }>(
  (_, { counter }) => {
    counter.set(counter.get() + 1);
  },
);

const isEven = lift<{ counter: number }, boolean>(({ counter }) => {
  console.log("isEven", counter);
  return counter % 2 === 0;
});

export default recipe<{
  counter: Default<number, 0>;
}>("IfElseTest", ({ counter }) => {
  derive(counter, (c) => {
    console.log("derive counter: ", c);
  });
  return {
    [NAME]: str`counter: ${counter}`,
    [UI]: (
      <div>
        {isEven({ counter })
          ? <p>counter is even : {counter}</p>
          : <p>counter is odd : {counter}</p>}
        <p />
        <button type="button" onClick={incCounter({ counter })}>
          |click me|
        </button>
      </div>
    ),
  };
});
