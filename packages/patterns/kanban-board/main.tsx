/// <cts-enable />
/**
 * Kanban Board Pattern
 *
 * Layer 1: Data model + computed derivations + debug UI
 * Layer 2: Mutation handlers for cards and columns
 *
 * Data model uses nested structure: columns contain cards.
 * Array position determines ordering (simple and effective).
 */
import {
  Cell, Writable,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
} from "commontools";

// ============ HELPERS ============

const generateId = () => Math.random().toString(36).substring(2, 9);

const formatDate = (timestamp: number) => {
  if (!timestamp) return "Unknown";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

// ============ TYPES ============

interface Card {
  id: string;
  title: string;
  description: Default<string, "">;
  createdAt: Default<number, 0>; // timestamp
}

interface Column {
  id: string;
  title: string;
  cards: Default<Card[], []>;
}

// ============ INPUT/OUTPUT ============

interface State {
  columns: Writable<
    Default<
      Column[],
      [
        { id: "todo"; title: "To Do"; cards: [] },
        { id: "in-progress"; title: "In Progress"; cards: [] },
        { id: "done"; title: "Done"; cards: [] },
      ]
    >
  >;
}

interface Output {
  columns: Column[];
  totalCards: number;
  cardCounts: Record<string, number>;
  // Handlers as Streams
  addCard: Stream<{ columnId: string; title: string; description?: string }>;
  removeCard: Stream<{ columnId: string; cardId: string }>;
  moveCard: Stream<
    { cardId: string; fromColumnId: string; toColumnId: string }
  >;
  addColumn: Stream<{ title: string }>;
  removeColumn: Stream<{ columnId: string }>;
}

// ============ HANDLERS ============

const addCardHandler = handler<
  { columnId: string; title: string; description?: string },
  { columns: Writable<Column[]> }
>(({ columnId, title, description }, { columns }) => {
  if (!title?.trim()) return;

  const cols = columns.get();
  const colIndex = cols.findIndex((c) => c.id === columnId);
  if (colIndex < 0) return;

  const newCard: Card = {
    id: generateId(),
    title: title.trim(),
    description: description?.trim() || "",
    createdAt: Date.now(),
  };

  columns.set(
    cols.map((col, i) =>
      i === colIndex ? { ...col, cards: [...col.cards, newCard] } : col
    ),
  );
});

const removeCardHandler = handler<
  { columnId: string; cardId: string },
  { columns: Writable<Column[]> }
>(({ columnId, cardId }, { columns }) => {
  const cols = columns.get();
  const colIndex = cols.findIndex((c) => c.id === columnId);
  if (colIndex < 0) return;

  columns.set(
    cols.map((col, i) =>
      i === colIndex
        ? { ...col, cards: col.cards.filter((card) => card.id !== cardId) }
        : col
    ),
  );
});

const moveCardHandler = handler<
  { cardId: string; fromColumnId: string; toColumnId: string },
  { columns: Writable<Column[]> }
>(({ cardId, fromColumnId, toColumnId }, { columns }) => {
  if (fromColumnId === toColumnId) return;

  const cols = columns.get();
  const fromIndex = cols.findIndex((c) => c.id === fromColumnId);
  const toIndex = cols.findIndex((c) => c.id === toColumnId);
  if (fromIndex < 0 || toIndex < 0) return;

  const card = cols[fromIndex].cards.find((c) => c.id === cardId);
  if (!card) return;

  columns.set(
    cols.map((col, i) => {
      if (i === fromIndex) {
        return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
      }
      if (i === toIndex) {
        return { ...col, cards: [...col.cards, card] };
      }
      return col;
    }),
  );
});

const addColumnHandler = handler<
  { title: string },
  { columns: Writable<Column[]> }
>(({ title }, { columns }) => {
  if (!title?.trim()) return;

  const newColumn: Column = {
    id: generateId(),
    title: title.trim(),
    cards: [],
  };

  columns.push(newColumn);
});

const removeColumnHandler = handler<
  { columnId: string },
  { columns: Writable<Column[]> }
>(({ columnId }, { columns }) => {
  const cols = columns.get();
  const index = cols.findIndex((c) => c.id === columnId);
  if (index >= 0) {
    columns.set(cols.toSpliced(index, 1));
  }
});

// ============ PATTERN ============

export default pattern<State>(({ columns }) => {
  // ============ BOUND HANDLERS ============

  const addCard = addCardHandler({ columns });
  const removeCard = removeCardHandler({ columns });
  const moveCard = moveCardHandler({ columns });
  const addColumn = addColumnHandler({ columns });
  const removeColumn = removeColumnHandler({ columns });

  // ============ LOCAL UI STATE ============

  const newColumnTitle = Cell.of("");

  // Editing state (for future use - click handlers set these but no edit UI yet)
  const editingCardId = Cell.of<string | null>(null);
  const editingCardTitle = Cell.of("");
  const editingColumnId = Cell.of<string | null>(null);
  const editingColumnTitle = Cell.of("");

  // ============ COMPUTED DERIVATIONS ============

  // Total cards across all columns
  const totalCards = computed(() => {
    const cols = columns.get();
    let count = 0;
    for (const col of cols) {
      count += col.cards.length;
    }
    return count;
  });

  // Card counts per column (as a map)
  const cardCounts = computed(() => {
    const cols = columns.get();
    const counts: Record<string, number> = {};
    for (const col of cols) {
      counts[col.id] = col.cards.length;
    }
    return counts;
  });

  // Column count
  const columnCount = computed(() => columns.get().length);

  // ============ UI ============

  return {
    [NAME]: "Kanban Board",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h2 style={{ margin: "0 0 1rem 0" }}>Kanban Board</h2>

        {/* Stats bar + Add Column */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            marginBottom: "1rem",
            padding: "0.5rem",
            background: "#f5f5f5",
            borderRadius: "4px",
          }}
        >
          <div style={{ display: "flex", gap: "1rem" }}>
            <span>
              <strong>Columns:</strong> {columnCount}
            </span>
            <span>
              <strong>Total Cards:</strong> {totalCards}
            </span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <ct-input
              $value={newColumnTitle}
              placeholder="New column..."
              style="width: 150px;"
            />
            <ct-button
              onClick={() => {
                const title = newColumnTitle.get().trim();
                if (title) {
                  columns.push({
                    id: generateId(),
                    title,
                    cards: [],
                  });
                  newColumnTitle.set("");
                }
              }}
            >
              + Column
            </ct-button>
          </div>
        </div>

        {/* Kanban columns */}
        <div
          style={{
            display: "flex",
            gap: "1rem",
            overflowX: "auto",
            paddingBottom: "1rem",
          }}
        >
          {columns.map((column) => (
            <div
              style={{
                minWidth: "250px",
                maxWidth: "300px",
                background: "#f0f0f0",
                borderRadius: "8px",
                padding: "0.75rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {/* Column header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingBottom: "0.5rem",
                  borderBottom: "2px solid #ddd",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    flex: 1,
                  }}
                >
                  {/* Column title - clickable to edit */}
                  <h3
                    style={{ margin: 0, fontSize: "1rem", cursor: "pointer" }}
                    onClick={() => {
                      editingColumnId.set(column.id);
                      editingColumnTitle.set(column.title);
                    }}
                  >
                    {column.title}
                  </h3>
                  <span
                    style={{
                      background: "#ddd",
                      borderRadius: "12px",
                      padding: "2px 8px",
                      fontSize: "0.75rem",
                    }}
                  >
                    {column.cards.length}
                  </span>
                </div>
                <ct-button
                  variant="ghost"
                  style="padding: 2px 6px; font-size: 0.8rem;"
                  onClick={() => {
                    const cols = columns.get();
                    const index = cols.findIndex((c) => c.id === column.id);
                    if (index >= 0) {
                      columns.set(cols.toSpliced(index, 1));
                    }
                  }}
                >
                  ×
                </ct-button>
              </div>

              {/* Cards */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  minHeight: "100px",
                }}
              >
                {column.cards.map((card) => (
                  <div
                    style={{
                      background: "#fff",
                      borderRadius: "6px",
                      padding: "0.75rem",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                      border: "1px solid #e8e8e8",
                    }}
                  >
                    {/* Card header with title and delete */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      {/* Card title - clickable to edit */}
                      <div
                        style={{
                          fontWeight: "500",
                          flex: 1,
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          editingCardId.set(card.id);
                          editingCardTitle.set(card.title);
                        }}
                      >
                        {card.title}
                      </div>
                      <ct-button
                        variant="ghost"
                        style="padding: 0 4px; font-size: 0.75rem; min-width: auto; opacity: 0.5;"
                        onClick={() => {
                          const cols = columns.get();
                          const colIndex = cols.findIndex((c) =>
                            c.id === column.id
                          );
                          if (colIndex >= 0) {
                            columns.set(
                              cols.map((col, i) =>
                                i === colIndex
                                  ? {
                                    ...col,
                                    cards: col.cards.filter((c) =>
                                      c.id !== card.id
                                    ),
                                  }
                                  : col
                              ),
                            );
                          }
                        }}
                      >
                        ×
                      </ct-button>
                    </div>

                    {/* Card description */}
                    {card.description && (
                      <div
                        style={{
                          fontSize: "0.85rem",
                          color: "#666",
                          marginTop: "0.25rem",
                        }}
                      >
                        {card.description}
                      </div>
                    )}

                    {/* Move buttons */}
                    <div
                      style={{
                        display: "flex",
                        gap: "4px",
                        marginTop: "0.5rem",
                        justifyContent: "flex-end",
                      }}
                    >
                      <ct-button
                        variant="ghost"
                        style="padding: 2px 6px; font-size: 0.7rem; min-width: auto;"
                        onClick={() => {
                          const cols = columns.get();
                          const fromIndex = cols.findIndex((c) =>
                            c.id === column.id
                          );
                          const toIndex = fromIndex - 1;
                          if (fromIndex > 0 && toIndex >= 0) {
                            const cardData = cols[fromIndex].cards.find(
                              (c) => c.id === card.id,
                            );
                            if (cardData) {
                              columns.set(
                                cols.map((col, i) => {
                                  if (i === fromIndex) {
                                    return {
                                      ...col,
                                      cards: col.cards.filter(
                                        (c) => c.id !== card.id,
                                      ),
                                    };
                                  }
                                  if (i === toIndex) {
                                    return {
                                      ...col,
                                      cards: [...col.cards, cardData],
                                    };
                                  }
                                  return col;
                                }),
                              );
                            }
                          }
                        }}
                      >
                        ←
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        style="padding: 2px 6px; font-size: 0.7rem; min-width: auto;"
                        onClick={() => {
                          const cols = columns.get();
                          const fromIndex = cols.findIndex((c) =>
                            c.id === column.id
                          );
                          const toIndex = fromIndex + 1;
                          if (fromIndex >= 0 && toIndex < cols.length) {
                            const cardData = cols[fromIndex].cards.find(
                              (c) => c.id === card.id,
                            );
                            if (cardData) {
                              columns.set(
                                cols.map((col, i) => {
                                  if (i === fromIndex) {
                                    return {
                                      ...col,
                                      cards: col.cards.filter(
                                        (c) => c.id !== card.id,
                                      ),
                                    };
                                  }
                                  if (i === toIndex) {
                                    return {
                                      ...col,
                                      cards: [...col.cards, cardData],
                                    };
                                  }
                                  return col;
                                }),
                              );
                            }
                          }
                        }}
                      >
                        →
                      </ct-button>
                    </div>

                    {/* Created date (always shown) */}
                    <div
                      style={{
                        fontSize: "0.7rem",
                        color: "#999",
                        marginTop: "0.5rem",
                      }}
                    >
                      {formatDate(card.createdAt)}
                    </div>
                  </div>
                ))}

                {/* Empty state */}
                {computed(() =>
                  column.cards.length === 0
                    ? (
                      <div
                        style={{
                          color: "#999",
                          fontStyle: "italic",
                          textAlign: "center",
                          padding: "1rem",
                        }}
                      >
                        No cards
                      </div>
                    )
                    : null
                )}
              </div>

              {/* Add card input */}
              <ct-message-input
                placeholder="Add a card..."
                onct-send={(e: { detail?: { message?: string } }) => {
                  const title = e.detail?.message?.trim();
                  if (title) {
                    const cols = columns.get();
                    const colIndex = cols.findIndex((c) => c.id === column.id);
                    if (colIndex >= 0) {
                      const newCard = {
                        id: generateId(),
                        title,
                        description: "",
                        createdAt: Date.now(),
                      };
                      columns.set(
                        cols.map((col, i) =>
                          i === colIndex
                            ? { ...col, cards: [...col.cards, newCard] }
                            : col
                        ),
                      );
                    }
                  }
                }}
              />
            </div>
          ))}
        </div>

        {/* Debug Panel */}
        <details style={{ marginTop: "1rem" }}>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Computed Values
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
              overflow: "auto",
            }}
          >
            {computed(() =>
              JSON.stringify(
                {
                  totalCards,
                  columnCount: columnCount,
                  cardCounts,
                },
                null,
                2
              )
            )}
          </pre>
        </details>

        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Raw Data
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
              overflow: "auto",
            }}
          >
            {computed(() => JSON.stringify(columns.get(), null, 2))}
          </pre>
        </details>
      </div>
    ),

    // Export for linking
    columns,
    totalCards,
    cardCounts,

    // Handlers (as Streams for cross-charm communication)
    addCard,
    removeCard,
    moveCard,
    addColumn,
    removeColumn,
  };
});
