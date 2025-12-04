/// <cts-enable />

import { Cell, computed, NAME, recipe, UI } from "commontools";
import Counter from "./counter.tsx";
import Note from "./note.tsx";

type Input = Record<string, never>;

type Result = {
  counterAValue: number;
  counterBValue: number;
  counterCValue: number;
};

export default recipe<Input, Result>(
  "ct-picker demo",
  (_) => {
    // Create counter instances - these are OpaqueRefs to recipe results
    const counterA = Counter({ value: 10 });
    const counterB = Note({ content: "This is item B (a Note)" });
    const counterC = Counter({ value: 30 });

    const selectedIndex = Cell.of(0);
    const items = [counterA, counterB, counterC];
    const selection = computed(() => items[selectedIndex.get()]);

    return {
      [NAME]: "ct-picker demo",
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "1rem" }}>
          <h3>ct-picker Component Demo</h3>

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
