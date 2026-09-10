/// <cts-enable />
/**
 * Sync List — minimal CRUD checklist with text + done.
 * Designed for bidirectional sync with a markdown file via sync-daemon.ts.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface Item {
  text: string;
  done: Default<boolean, false>;
}

interface Input {
  items?: Writable<Default<Item[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: Item[];
}

export default pattern<Input, Output>(({ items }) => {
  const addItem = action(({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (trimmed) {
      items.push({ text: trimmed, done: false });
    }
  });

  const deleteItem = action(({ index }: { index: number }) => {
    const current = items.get() || [];
    if (index >= 0 && index < current.length) {
      items.set(current.toSpliced(index, 1));
    }
  });

  const displayText = computed(() => {
    const list = items.get() || [];
    const total = list.length;
    if (total === 0) return "Empty";
    const done = list.filter((i) => i.done).length;
    return `${done}/${total}`;
  });

  return {
    [NAME]: computed(() => `Sync List: ${displayText}`),
    [UI]: (
      <ct-vstack gap="2">
        <ct-vstack gap="0">
          {items.map((item, index: number) => (
            <ct-hstack
              gap="2"
              style={{
                alignItems: "center",
                padding: "6px 8px",
                borderBottom: "1px solid var(--border-subtle, #f0f0f0)",
              }}
            >
              <ct-checkbox $checked={item.done} style={{ flexShrink: "0" }} />
              <ct-input
                $value={item.text}
                placeholder="..."
                style={{
                  flex: "1",
                  background: "transparent",
                  border: "none",
                  padding: "2px 4px",
                  fontSize: "14px",
                  textDecoration: item.done ? "line-through" : "none",
                  opacity: item.done ? "0.5" : "1",
                  color: "inherit",
                }}
              />
              <button
                type="button"
                onClick={() => deleteItem.send({ index })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                  fontSize: "14px",
                  color: "#ccc",
                  opacity: "0.5",
                  transition: "opacity 0.15s",
                }}
                title="Delete"
              >
                x
              </button>
            </ct-hstack>
          ))}
        </ct-vstack>
        <ct-message-input
          placeholder="Add item..."
          button-text="+"
          style={{ fontSize: "14px" }}
          onct-send={(e: { detail?: { message?: string } }) => {
            const text = e.detail?.message;
            if (text) addItem.send({ text });
          }}
        />
      </ct-vstack>
    ),
    items,
  };
});
