/// <cts-enable />

import {
  Cell,
  computed,
  Default,
  NAME,
  OpaqueCell,
  recipe,
  UI,
} from "commontools";
import Counter from "./counter.tsx";
import Note from "./note.tsx";

type Input = {
  dummy: Cell<Default<number, 0>>;
};

type Result = {
  counterAValue: number;
  counterBValue: number;
  counterCValue: number;
};

export default recipe<Input, Result>(
  "ct-select-test demo",
  ({ dummy }) => {
    // Create counter instances - these are OpaqueRefs to recipe results
    const counterA = Counter({ value: 10 });
    const counterB = Note({ content: "This is item B (a Note)" });
    const counterC = Counter({ value: 30 });

    const selectedIndex = Cell.of(0);
    const items = [counterA, counterB, counterC];
    const selection = computed(() => items[selectedIndex.get()]);

    return {
      [NAME]: "ct-select-test demo",
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "1rem" }}>
          <h3>ct-select-test Component Demo</h3>

          <ct-card>
            <ct-button
              onClick={() => {
                selectedIndex.set(Math.max(0, selectedIndex.get() - 1));
              }}
            >
              Prev
            </ct-button>
            <ct-button
              onClick={() => {
                selectedIndex.set(
                  Math.min(items.length - 1, selectedIndex.get() + 1),
                );
              }}
            >
              Next
            </ct-button>
            <div>
              {selection}
            </div>
          </ct-card>

          <ct-card>
            <ct-picker items={items} $selectedIndex={selectedIndex} />
          </ct-card>
        </ct-vstack>
      ),
      counterAValue: counterA.value,
      counterBValue: 0, // Note doesn't have .value
      counterCValue: counterC.value,
    };
  },
);
