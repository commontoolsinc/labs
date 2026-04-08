import {
  Cell,
  Default,
  derive,
  handler,
  NAME,
  pattern,
  str,
  UI,
} from "commonfabric";

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

export default pattern<
  { error: Cell<Default<string, "">>; counter: Cell<Default<number, 0>> }
>(
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
          <cf-input
            value={error}
            placeholder="Error"
            oncf-input={updateError({ error })}
          />
          <cf-updater
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
