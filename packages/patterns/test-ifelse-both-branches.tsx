/// <cts-enable />
import { Default, NAME, recipe, Stream, UI, handler, ifElse } from "commontools";

// TEST PATTERN: ifElse Executes BOTH Branches
// CLAIM: "ifElse evaluates BOTH branches, not just the 'true' one." (From blessed/reactivity.md)
// See test-ifelse-both-branches.md for full documentation and testing instructions.

interface TestState {
  condition: Default<boolean, false>;
  trueCount: Default<number, 0>;
  falseCount: Default<number, 0>;
}

interface TestOutput {
  condition: Default<boolean, false>;
  trueCount: Default<number, 0>;
  falseCount: Default<number, 0>;
  toggle: Stream<void>;
}

const toggle = handler((_, { condition }) => {
  condition.set(!condition.get());
});

const incrementTrue = handler((_, { trueCount }) => {
  trueCount.set(trueCount.get() + 1);
});

const incrementFalse = handler((_, { falseCount }) => {
  falseCount.set(falseCount.get() + 1);
});

export default recipe<TestState, TestOutput>((state) => {
  return {
    [NAME]: "ifElse Both Branches Test",
    [UI]: (
      <div>
        <ct-button onClick={toggle(state)}>
          Condition: {state.condition ? "TRUE" : "FALSE"}
        </ct-button>
        {ifElse(
          state.condition,
          <ct-button onClick={incrementTrue({ trueCount: state.trueCount })}>
            True button ({state.trueCount})
          </ct-button>,
          <ct-button onClick={incrementFalse({ falseCount: state.falseCount })}>
            False button ({state.falseCount})
          </ct-button>
        )}
        <span>True: {state.trueCount}, False: {state.falseCount}</span>
      </div>
    ),
    condition: state.condition,
    trueCount: state.trueCount,
    falseCount: state.falseCount,
    toggle: toggle(state) as unknown as Stream<void>,
  };
});
