import { computed, NAME, pattern, UI, Writable } from "commonfabric";
import Counter from "../counter/counter.tsx";
import Note from "../notes/note.tsx";

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
    });
    const counterC = Counter({ value: 30 });

    const selectedIndex = Writable.of(0);
    const items = [counterA, counterB, counterC];
    const selection = computed(() => items[selectedIndex.get()]);

    return {
      [NAME]: "cf-picker demo",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <h3>cf-picker Component Demo</h3>

          <cf-card>
            <cf-button
              onClick={() => {
                selectedIndex.set(Math.max(0, selectedIndex.get() - 1));
              }}
            >
              Prev
            </cf-button>
            <cf-button
              onClick={() => {
                selectedIndex.set(
                  Math.min(items.length - 1, selectedIndex.get() + 1),
                );
              }}
            >
              Next
            </cf-button>
            <div>
              {selection}
            </div>
          </cf-card>

          <cf-card>
            {/* The cast is because OpaqueCell does not satisfy CellLike, but... it is */}
            <cf-picker $items={items as any} $selectedIndex={selectedIndex} />
          </cf-card>
        </cf-vstack>
      ),
      counterAValue: counterA.value,
      counterBValue: 0, // Note doesn't have .value
      counterCValue: counterC.value,
    };
  },
);
