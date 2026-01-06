/// <cts-enable />
import { Cell, Writable, Default, NAME, pattern, UI, wish } from "commontools";

interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Writable<Default<TodoItem[], []>>;
}

interface Output {
  items: Writable<TodoItem[]>;
}

export default pattern<Input, Output>(({ items }) => {
  return {
    [NAME]: "Todo with Suggestions",
    [UI]: (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2>Todo List</h2>

        {/* Add new item */}
        <ct-message-input
          placeholder="Add a todo item..."
          onct-send={(e: { detail?: { message?: string } }) => {
            const title = e.detail?.message?.trim();
            if (title) {
              items.push({ title, done: false });
            }
          }}
        />

        {/* Todo items with per-item suggestions */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {items.map((item) => {
            // AI suggestion based on current todos
            const wishResult = wish({
              query: item.title,
              context: { item, items },
            });

            return (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  padding: "8px",
                  border: "1px solid #e0e0e0",
                  borderRadius: "8px",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <ct-checkbox $checked={item.done}>
                    <span
                      style={item.done
                        ? { textDecoration: "line-through", opacity: 0.6 }
                        : {}}
                    >
                      <ct-textarea $value={item.title} />
                    </span>
                  </ct-checkbox>
                  <ct-button
                    onClick={() => {
                      const current = items.get();
                      const index = current.findIndex((el) =>
                        Cell.equals(item, el)
                      );
                      if (index >= 0) {
                        items.set(current.toSpliced(index, 1));
                      }
                    }}
                  >
                    ×
                  </ct-button>
                </div>

                <details open>
                  <summary>AI Suggestion</summary>
                  {wishResult}
                </details>
              </div>
            );
          })}
        </div>
      </div>
    ),
    items,
  };
});
