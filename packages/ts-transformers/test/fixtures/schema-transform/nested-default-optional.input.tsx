/// <cts-enable />
import { type Cell, Default, handler, recipe } from "commontools";

interface OptionalBranch {
  counter?: number;
  label?: string;
}

interface OptionalNested {
  branch?: OptionalBranch;
}

interface NestedOptionalState {
  nested?: OptionalNested;
}

interface NestedOptionalArgs {
  // deno-lint-ignore ban-types
  state: Default<NestedOptionalState, {}>;
}

const increment = handler((_, context: { state: Cell<NestedOptionalState> }) => {
  const current = context.state.get() ?? {};
  const branch = current.nested?.branch ?? {};
  const counter = (branch.counter ?? 0) + 1;
  context.state.set({ nested: { branch: { counter } } });
});

export default recipe<NestedOptionalArgs>(
  "Nested Optional Default",
  ({ state }) => {
    return {
      state,
      increment: increment({ state }),
    };
  },
);