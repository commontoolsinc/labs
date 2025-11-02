/// <cts-enable />
import { cell, Cell, Default, derive, handler, ifElse, NAME, recipe, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

// Simple list view
const ListView = recipe<{ items: Default<Item[], []> }>(
  "List View",
  ({ items }) => ({
    [NAME]: "List View",
    [UI]: (
      <common-vstack gap="sm" style={{ padding: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>List View</h3>
        {items.map((item) => (
          <div style={{ padding: "4px 0" }}>• {item.title}</div>
        ))}
      </common-vstack>
    ),
    items,
  })
);

// Grid view
const GridView = recipe<{ items: Default<Item[], []> }>(
  "Grid View",
  ({ items }) => ({
    [NAME]: "Grid View",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Grid View</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
          {items.map((item) => (
            <div style={{ border: "1px solid #ddd", padding: "12px", borderRadius: "4px" }}>
              {item.title}
            </div>
          ))}
        </div>
      </div>
    ),
    items,
  })
);

// Handler that creates patterns on-demand
const selectView = handler<
  unknown,
  { currentView: Cell<any>; items: any; viewType: string }
>((_event, { currentView, items, viewType }) => {
  // Create pattern when user selects it
  const view = viewType === "list"
    ? ListView({ items })
    : GridView({ items });

  currentView.set(view);
});

export default recipe<{ items: Default<Item[], []> }>(
  "On-Demand Pattern Example",
  ({ items }) => {
    const currentView = cell<any>(null);
    const hasView = derive(currentView, (v) => v !== null);

    return {
      [NAME]: "View Selector",
      [UI]: (
        <common-vstack gap="md" style={{ padding: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Select a View</h3>

          <common-hstack gap="sm">
            <ct-button onClick={selectView({ currentView, items, viewType: "list" })}>
              List View
            </ct-button>
            <ct-button onClick={selectView({ currentView, items, viewType: "grid" })}>
              Grid View
            </ct-button>
          </common-hstack>

          <div style={{ marginTop: "16px", border: "1px solid #e0e0e0", borderRadius: "4px" }}>
            {ifElse(
              hasView,
              <div>{currentView}</div>,
              <div style={{ padding: "2rem", textAlign: "center", color: "#666" }}>
                Choose a view above
              </div>
            )}
          </div>
        </common-vstack>
      ),
      items,
    };
  }
);
