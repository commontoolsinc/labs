/// <cts-enable />

import { Default, NAME, recipe, UI } from "commontools";

type Input = {
  selected: Default<string, "opt_1">;
  numericChoice: Default<number, 1>;
  category: Default<string, "Other">;
};

type Result = {
  selected: string;
  numericChoice: number;
  category: string;
};

export default recipe<Input, Result>(
  "ct-select demo",
  ({ selected, numericChoice, category }) => {
    return {
      [NAME]: "ct-select demo",
      [UI]: (
        <common-vstack gap="lg" style={{ padding: "1rem" }}>
          <h3>ct-select Component Demo</h3>

          <ct-card>
            <h4>String Values</h4>
            <p>
              ct-select uses an `items` attribute with {`{label, value}`}{" "}
              objects
            </p>
            <ct-select
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              $value={selected}
            />
            <p>Selected: {selected}</p>
          </ct-card>

          <ct-card>
            <h4>Numeric Values</h4>
            <p>Values can be any type, not just strings</p>
            <ct-select
              items={[
                { label: "First Item", value: 1 },
                { label: "Second Item", value: 2 },
                { label: "Third Item", value: 3 },
              ]}
              $value={numericChoice}
            />
            <p>Selected number: {numericChoice}</p>
          </ct-card>

          <ct-card>
            <h4>Common Categories Example</h4>
            <ct-select
              $value={category}
              items={[
                { label: "Produce", value: "Produce" },
                { label: "Dairy", value: "Dairy" },
                { label: "Meat", value: "Meat" },
                { label: "Bakery", value: "Bakery" },
                { label: "Other", value: "Other" },
              ]}
            />
            <p>Selected category: {category}</p>
          </ct-card>
        </common-vstack>
      ),
      selected,
      numericChoice,
      category,
    };
  },
);
