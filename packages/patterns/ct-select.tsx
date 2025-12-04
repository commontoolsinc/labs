/// <cts-enable />

import { Cell, Default, NAME, OpaqueCell, recipe, UI } from "commontools";
import Counter from "./counter.tsx";
import Note from "./note.tsx";

type Input = {
  selected: Cell<Default<string, "opt_1">>;
  numericChoice: Cell<Default<number, 1>>;
  category: Cell<Default<string, "Other">>;
  pickerSelection: Cell<Default<unknown, null>>;
};

type Result = {
  selected: string;
  numericChoice: number;
  category: string;
};

export default recipe<Input, Result>(
  "ct-select demo",
  ({ selected, numericChoice, category, pickerSelection }) => {
    // Create counter instances for ct-picker demo

    const counterA = Counter({ value: 1 });
    const counterB = Note({ content: "test" });
    const counterC = Counter({ value: 3 });

    const counters = [counterA, counterB, counterC];

    const selection = Cell.of<OpaqueCell<unknown>>(counterA);

    return {
      [NAME]: "ct-select demo",
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "1rem" }}>
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

          <ct-card>
            <h4>ct-picker + ct-select Synchronization</h4>
            <p>
              ct-picker displays cells with [UI] in a card stack. Both
              components share the same selection state.
            </p>
            <div style={{ marginBottom: "1rem" }}>
              <ct-picker
                $items={counters}
                $value={selection}
                min-height="250px"
              />
            </div>
            {
              /*<ct-select
              items={counters.map((counter, i) => ({
                label: `Counter ${i + 1}`,
                value: counter,
              }))}
              $value={pickerSelection}
            />*/
            }
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "0.875rem",
                color: "#666",
              }}
            >
              Try using the arrows in the picker or changing the dropdown - they
              stay in sync!
            </p>
          </ct-card>
        </ct-vstack>
      ),
      selected,
      numericChoice,
      category,
    };
  },
);
