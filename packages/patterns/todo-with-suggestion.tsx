/// <cts-enable />
import { Cell, Default, derive, NAME, pattern, UI } from "commontools";
import { Suggestion } from "./suggestion.tsx";

interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Cell<TodoItem[]>;
}

interface Output {
  items: Cell<TodoItem[]>;
}

export default pattern<Input, Output>(({ items }) => {
  // AI suggestion based on current todos
  const suggestion = Suggestion({
    situation: "Based on my todo list, use a pattern to help me.",
    context: { items },
  });

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
                      {item.title}
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
              </div>
            );
          })}
        </div>

        {/* AI Suggestion */}
        <div
          style={{
            marginTop: "16px",
            padding: "12px",
            backgroundColor: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          <h3>AI Suggestion</h3>
          {derive(suggestion, (s) =>
            s?.cell ?? (
              <span style={{ opacity: 0.6 }}>Getting suggestion...</span>
            ))}
        </div>
      </div>
    ),
    items,
    suggestion,
  };
});
