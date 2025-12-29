/// <cts-enable />
import {
  Cell,
  cell,
  compileAndRun,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Input {
  // The child pattern source code to compile and run
  childSource: Default<string, "">;
}

// Handler to add items to the shared array from parent
const addItemToShared = handler<
  { detail: { message: string } },
  { sharedItems: Cell<string[]> }
>((event, { sharedItems }) => {
  const text = event.detail.message.trim();
  if (text) {
    const current = sharedItems.get();
    sharedItems.set([...current, text]);
    console.log("[Parent] Added item:", text, "Array now:", sharedItems.get());
  }
});

export default pattern<Input>(({ childSource }) => {
  // Create a Cell<string[]> that will be shared with the child
  const sharedItems = cell<string[]>([]);

  // Compile and run the child pattern, passing the shared Cell as input
  const compileParams = computed(() => ({
    files: childSource
      ? [{ name: "/child.tsx", contents: childSource }]
      : [],
    main: childSource ? "/child.tsx" : "",
    input: {
      // Pass the shared Cell as input to the child pattern
      items: sharedItems,
    },
  }));

  const compiled = compileAndRun(compileParams);

  // Check if child is ready
  const childReady = computed(
    () => !compiled.pending && !!compiled.result && !compiled.error,
  );

  const itemCount = computed(() => sharedItems.get().length);

  return {
    [NAME]: computed(() => `Parent Pattern (${itemCount} items shared)`),
    [UI]: (
      <div style={{ padding: "16px", border: "2px solid red" }}>
        <h2>Parent Pattern</h2>
        <p>Shared item count: {itemCount}</p>

        {ifElse(
          compiled.pending,
          <p style={{ color: "orange" }}>Compiling child pattern...</p>,
          ifElse(
            compiled.error,
            <div style={{ color: "red" }}>
              <b>Compile error:</b> {compiled.error}
            </div>,
            ifElse(
              childReady,
              <div>
                <p style={{ color: "green" }}>Child pattern loaded!</p>
                <ct-message-input
                  placeholder="Add item from parent..."
                  onct-send={addItemToShared({ sharedItems })}
                />
                <h4>Shared Items (parent view):</h4>
                <ul>
                  {sharedItems.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
                <div style={{ marginTop: "16px" }}>
                  <h4>Child Pattern (embedded):</h4>
                  {compiled.result}
                </div>
              </div>,
              <p style={{ opacity: 0.6 }}>Waiting for child source...</p>,
            ),
          ),
        )}
      </div>
    ),
    sharedItems,
    childReady,
    addItemToShared: addItemToShared({ sharedItems }),
  };
});
