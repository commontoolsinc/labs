/// <cts-enable />

import { Cell, Default, NAME, pattern, UI } from "commontools";

type Input = {
  selected: Cell<Default<string, "opt_1">>;
  numericChoice: Cell<Default<number, 1>>;
  category: Cell<Default<string, "Other">>;
  activeTab: Cell<Default<string, "tab1">>;
};

type Result = {
  selected: string;
  numericChoice: number;
  category: string;
  activeTab: string;
};

export default pattern<Input, Result>(
  ({ selected, numericChoice, category, activeTab }) => {
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
            <h4>
              <code>ct-autocomplete</code>
            </h4>
            <ct-autocomplete
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              $value={selected}
            />
          </ct-card>

          <ct-card>
            <h4>
              <code>ct-radio-group</code>
            </h4>
            <ct-radio-group
              $value={selected}
              items={[
                { label: "Option 1", value: "opt_1" },
                { label: "Option 2", value: "opt_2" },
                { label: "Option 3", value: "opt_3" },
              ]}
              orientation="horizontal"
            />
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
            <h4>
              <code>ct-tabs</code>
            </h4>
            <p>Tabs use $value binding for the active tab</p>
            <ct-tabs $value={activeTab}>
              <ct-tab-list>
                <ct-tab value="tab1">First Tab</ct-tab>
                <ct-tab value="tab2">Second Tab</ct-tab>
                <ct-tab value="tab3">Third Tab</ct-tab>
              </ct-tab-list>
              <ct-tab-panel value="tab1">
                <p>Content for the first tab panel.</p>
              </ct-tab-panel>
              <ct-tab-panel value="tab2">
                <p>Content for the second tab panel.</p>
              </ct-tab-panel>
              <ct-tab-panel value="tab3">
                <p>Content for the third tab panel.</p>
              </ct-tab-panel>
            </ct-tabs>
            <p>Active tab: {activeTab}</p>
          </ct-card>
        </ct-vstack>
      ),
      selected,
      numericChoice,
      category,
      activeTab,
    };
  },
);
