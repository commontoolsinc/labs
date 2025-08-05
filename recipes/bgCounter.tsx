/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const updater = handler<
  { delta: number },
  { counter: Cell<number>; error: string }
>(
  ({ delta }, state) => {
    if (state.error) {
      console.error("testing throwing an error! in updater");
      throw new Error(state.error);
    }
    state.counter.set((state.counter.get() ?? 0) + (delta ?? 1));
  },
);

const updateError = handler<
  { detail: { value: string } },
  { error: Cell<string> }
>(
  ({ detail }, state) => {
    state.error.set(detail?.value ?? "");
  },
);

export default recipe<
  { error: Default<string, "">; counter: Default<number, 0> }
>(
  "bgCounter",
  ({ counter, error }) => {
    derive(counter, (counter) => {
      console.log("counter#", counter);
    });
    return {
      [NAME]: str`Counter: ${derive(counter, (counter) => counter)}`,
      [UI]: (
        <div>
          <button type="button" onClick={updater({ counter, error })}>
            Update Counter
          </button>
          <p>If error is set, the update function will throw an error</p>
          <common-input
            value={error}
            placeholder="Error"
            oncommon-input={updateError({ error })}
          />
          <common-updater
            id="registerBgCounter"
            $state={counter}
            integration="counter"
          />
          <h1 id="countValue">
            {counter}
          </h1>
        </div>
      ),
      bgUpdater: updater({ counter, error }),
      counter,
    };
  },
);
