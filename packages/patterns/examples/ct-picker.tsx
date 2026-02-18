/// <cts-enable />

import { computed, NAME, pattern, UI, Writable } from "commontools";
import Counter from "../counter/counter.tsx";
import Note from "../notes/note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

type Input = Record<string, never>;

type Result = {
  counterAValue: number;
  counterBValue: number;
  counterCValue: number;
};

export default pattern<Input, Result>(
  (_) => {
    // Create counter instances - these are OpaqueRefs to pattern results
    const counterA = Counter({ value: 10 });
    const counterB = Note({
      content: "This is item B (a Note)",
      noteId: generateId(),
    });
    const counterC = Counter({ value: 30 });

    const selectedIndex = Writable.of(0);
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
            {/* The cast is because OpaqueCell does not satisfy CellLike, but... it is */}
            <ct-picker $items={items as any} $selectedIndex={selectedIndex} />
          </ct-card>
        </ct-vstack>
      ),
      counterAValue: counterA.value,
      counterBValue: 0, // Note doesn't have .value
      counterCValue: counterC.value,
    };
  },
);
