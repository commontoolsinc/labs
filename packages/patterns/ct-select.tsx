/// <cts-enable />

import {
  Cell,
  cell,
  compileAndRun,
  Default,
  derive,
  h,
  handler,
  ifElse,
  Mutable,
  NAME,
  navigateTo,
  Opaque,
  OpaqueRef,
  recipe,
  render,
  str,
  UI,
} from "commontools";

type Input = {
  selected: Default<string, "">;
};

type Result = {
  selected: string;
};

export default recipe<Input, Result>(
  "ct-select demo",
  ({ selected }) => {
    return {
      [NAME]: "ct-tags demo",
      [UI]: (
        <common-vstack gap="lg" style={{ padding: "1rem" }}>
          <ct-select
            items={[
              { value: "opt_1", label: "Option 1" },
              {
                value: "opt_2",
                label: "Option 2",
              },
              {
                value: "opt_3",
                label: "Option 3",
              },
            ]}
            $value={selected}
          />
        </common-vstack>
      ),
      selected,
    };
  },
);
