/// <cts-enable />
import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

interface ProjectItem {
  id: string;
  text: string;
  parentId: string;
  note: string;
  wishes: Wish[];
}

interface Wish {
  text: string;
  createdAt: string;
  status: string; // "pending" | "done"
}

interface UserAction {
  type: string;
  target?: string;
  text?: string;
  ts: string;
}

interface ProjectsInput {
  items: Writable<Default<ProjectItem[], []>>;
}

interface ProjectsOutput {
  [NAME]: string;
  [UI]: VNode;
  userActions: UserAction[];
}

// ===== Apple-style Design Tokens =====

const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif";

const color = {
  label: "#1d1d1f",
  secondaryLabel: "#86868b",
  tertiaryLabel: "#aeaeb2",
  separator: "rgba(60, 60, 67, 0.12)",
  fillPrimary: "rgba(120, 120, 128, 0.08)",
  background: "#ffffff",
  secondaryBg: "#f5f5f7",
  blue: "#007aff",
  green: "#34c759",
  orange: "#ff9500",
  red: "#ff3b30",
  indigo: "#5856d6",
  purple: "#af52de",
};

// ===== Helpers =====

let counter = 0;
function nextId(): string {
  counter++;
  return "item-" + Date.now().toString(36) + "-" + counter;
}

// ===== Pattern =====

const GTDProjects = pattern<ProjectsInput, ProjectsOutput>(({ items }) => {
  // --- Local UI state ---
  const breadcrumbs = Writable.of<string[]>([]); // "id|text" encoded
  const addDraft = Writable.of<string>("");
  const editingId = Writable.of<string>(""); // id of item being inline-edited
  const editingText = Writable.of<string>("");
  const selectedId = Writable.of<string>(""); // id of selected item (for actions)

  // Note modal state
  const noteEditId = Writable.of<string>(""); // id of item whose note is open
  const noteEditText = Writable.of<string>("");

  // Wish modal state
  const wishViewId = Writable.of<string>(""); // id of item whose wishes are shown
  const wishDraft = Writable.of<string>("");

  // userActions output (for directive wishes)
  const userActions = Writable.of<UserAction[]>([]);

  // --- Actions ---

  const addItem = action(() => {
    const text = addDraft.get().trim();
    if (!text) return;
    const all = [...(items.get() || [])];
    const crumbs = breadcrumbs.get() || [];
    let parentId = "";
    if (crumbs.length > 0) {
      const last = crumbs[crumbs.length - 1];
      parentId = last.substring(0, last.indexOf("|"));
    }
    all.push({ id: nextId(), text, parentId, note: "", wishes: [] });
    items.set(all);
    addDraft.set("");
  });

  const deleteItem = action(({ id }: { id: string }) => {
    const all = [...(items.get() || [])];
    // Recursively collect ids to delete
    const toDelete = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      toDelete.add(current);
      for (const item of all) {
        if (item.parentId === current) queue.push(item.id);
      }
    }
    items.set(all.filter((item: ProjectItem) => !toDelete.has(item.id)));
    if (selectedId.get() === id) selectedId.set("");
  });

  const startEdit = action(({ id, text }: { id: string; text: string }) => {
    editingId.set(id);
    editingText.set(text);
  });

  const saveEdit = action(() => {
    const id = editingId.get();
    const newText = editingText.get().trim();
    if (!id || !newText) {
      editingId.set("");
      editingText.set("");
      return;
    }
    const all = [...(items.get() || [])];
    const idx = all.findIndex((item: ProjectItem) => item.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], text: newText };
      items.set(all);
    }
    editingId.set("");
    editingText.set("");
  });

  const cancelEdit = action(() => {
    editingId.set("");
    editingText.set("");
  });

  const selectItem = action(({ id }: { id: string }) => {
    selectedId.set(selectedId.get() === id ? "" : id);
  });

  const drillIn = action(({ id, text }: { id: string; text: string }) => {
    const crumbs = [...(breadcrumbs.get() || [])];
    crumbs.push(id + "|" + text);
    breadcrumbs.set(crumbs);
    selectedId.set("");
  });

  const navigateBreadcrumb = action(({ depth }: { depth: number }) => {
    if (depth < 0) {
      breadcrumbs.set([]);
    } else {
      const crumbs = [...(breadcrumbs.get() || [])];
      breadcrumbs.set(crumbs.slice(0, depth + 1));
    }
    selectedId.set("");
  });

  // Note modal
  const openNote = action(({ id, note }: { id: string; note: string }) => {
    noteEditId.set(id);
    noteEditText.set(note || "");
  });

  const saveNote = action(() => {
    const id = noteEditId.get();
    if (!id) return;
    const all = [...(items.get() || [])];
    const idx = all.findIndex((item: ProjectItem) => item.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], note: noteEditText.get() };
      items.set(all);
    }
    noteEditId.set("");
    noteEditText.set("");
  });

  const closeNote = action(() => {
    noteEditId.set("");
    noteEditText.set("");
  });

  // Wish modal
  const openWishes = action(({ id }: { id: string }) => {
    wishViewId.set(id);
    wishDraft.set("");
  });

  const closeWishes = action(() => {
    wishViewId.set("");
    wishDraft.set("");
  });

  const addWish = action(() => {
    const id = wishViewId.get();
    const text = wishDraft.get().trim();
    if (!id || !text) return;
    const now = new Date().toISOString();
    const all = [...(items.get() || [])];
    const idx = all.findIndex((item: ProjectItem) => item.id === id);
    if (idx >= 0) {
      const wishes = [...(all[idx].wishes || [])];
      wishes.push({ text, createdAt: now, status: "pending" });
      all[idx] = { ...all[idx], wishes };
      items.set(all);
    }
    // Emit as directive userAction
    const itemText = idx >= 0 ? all[idx].text : id;
    userActions.set([
      ...userActions.get(),
      { type: "directive", target: id, text: "Wish on [" + itemText + "]: " + text, ts: now },
    ]);
    wishDraft.set("");
  });

  const toggleWishStatus = action(({ itemId, wishIdx }: { itemId: string; wishIdx: number }) => {
    const all = [...(items.get() || [])];
    const idx = all.findIndex((item: ProjectItem) => item.id === itemId);
    if (idx >= 0) {
      const wishes = [...(all[idx].wishes || [])];
      if (wishIdx >= 0 && wishIdx < wishes.length) {
        wishes[wishIdx] = {
          ...wishes[wishIdx],
          status: wishes[wishIdx].status === "done" ? "pending" : "done",
        };
        all[idx] = { ...all[idx], wishes };
        items.set(all);
      }
    }
  });

  // --- Styles ---

  const itemRowBase = {
    padding: "10px 0",
    borderBottom: "0.5px solid " + color.separator,
    display: "flex",
    alignItems: "center",
    gap: "8px",
  };

  const iconBtn = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: "0",
    fontSize: "10px",
    fontWeight: "600",
    padding: "2px 8px",
    borderRadius: "100px",
  };

  // --- Render ---

  return {
    [NAME]: "GTD Projects",
    userActions,
    [UI]: computed(() => {
      const all: ProjectItem[] = [...(items.get() || [])];
      const crumbStrs = breadcrumbs.get() || [];
      const crumbs = crumbStrs.map((s: string) => {
        const bar = s.indexOf("|");
        return { id: bar >= 0 ? s.substring(0, bar) : s, text: bar >= 0 ? s.substring(bar + 1) : s };
      });

      // Current parent
      const currentParentId = crumbs.length > 0 ? crumbs[crumbs.length - 1].id : "";

      // Children at this level
      const levelItems = all.filter((item: ProjectItem) =>
        currentParentId ? item.parentId === currentParentId : !item.parentId
      );

      // Children-of map for chevron display
      const childCount: Record<string, number> = {};
      for (const item of all) {
        if (item.parentId) {
          childCount[item.parentId] = (childCount[item.parentId] || 0) + 1;
        }
      }

      // Note modal item
      const noteId = noteEditId.get();
      const noteItem = noteId ? all.find((item: ProjectItem) => item.id === noteId) : null;

      // Wish modal item
      const wishId = wishViewId.get();
      const wishItem = wishId ? all.find((item: ProjectItem) => item.id === wishId) : null;

      return (
        <div
          style={{
            fontFamily: font,
            maxWidth: "600px",
            margin: "0 auto",
            padding: "20px 16px",
            background: color.background,
            minHeight: "100vh",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                fontSize: "28px",
                fontWeight: "700",
                color: color.label,
                letterSpacing: "-0.5px",
              }}
            >
              GTD Projects
            </div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: "600",
                color: color.secondaryLabel,
                padding: "4px 12px",
                borderRadius: "100px",
                background: color.fillPrimary,
              }}
            >
              {all.length + " items"}
            </div>
          </div>

          {/* Breadcrumbs */}
          {crumbs.length > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0",
                flexWrap: "wrap" as const,
                padding: "4px 0 12px",
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: "500",
                  color: color.blue,
                  cursor: "pointer",
                }}
                onClick={() => navigateBreadcrumb.send({ depth: -1 })}
              >
                Root
              </span>
              {crumbs.map(
                (c: { id: string; text: string }, i: number) => (
                  <span style={{ display: "inline-flex", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: "12px",
                        color: color.tertiaryLabel,
                        margin: "0 6px",
                      }}
                    >
                      /
                    </span>
                    {i < crumbs.length - 1 ? (
                      <span
                        style={{
                          fontSize: "13px",
                          fontWeight: "500",
                          color: color.blue,
                          cursor: "pointer",
                        }}
                        onClick={() => navigateBreadcrumb.send({ depth: i })}
                      >
                        {c.text}
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: "13px",
                          fontWeight: "600",
                          color: color.label,
                        }}
                      >
                        {c.text}
                      </span>
                    )}
                  </span>
                ),
              )}
            </div>
          ) : null}

          {/* Add Item Input */}
          <div
            style={{
              display: "flex",
              gap: "8px",
              marginBottom: "16px",
              alignItems: "center",
            }}
          >
            <ct-input
              $value={addDraft}
              placeholder={crumbs.length > 0 ? "Add sub-item..." : "Add item..."}
              style={{
                flex: "1",
                fontSize: "14px",
                borderRadius: "10px",
              }}
            />
            <div
              onClick={addItem}
              style={{
                padding: "8px 16px",
                borderRadius: "100px",
                fontSize: "13px",
                fontWeight: "600",
                background: color.blue,
                color: "#fff",
                cursor: "pointer",
                flexShrink: "0",
              }}
            >
              Add
            </div>
          </div>

          {/* Section label */}
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: color.secondaryLabel,
              textTransform: "uppercase" as const,
              letterSpacing: "0.5px",
              marginBottom: "4px",
            }}
          >
            {crumbs.length > 0
              ? crumbs[crumbs.length - 1].text + " (" + levelItems.length + ")"
              : "Items (" + levelItems.length + ")"}
          </div>

          {/* Empty state */}
          {levelItems.length === 0 ? (
            <div
              style={{
                fontSize: "14px",
                color: color.tertiaryLabel,
                padding: "24px 0",
                textAlign: "center" as const,
              }}
            >
              {crumbs.length > 0 ? "No sub-items yet" : "No items yet"}
            </div>
          ) : null}

          {/* Item list */}
          {levelItems.map((item: ProjectItem) => {
            const isSelected = selectedId.get() === item.id;
            const isEditing = editingId.get() === item.id;
            const hasChildren = (childCount[item.id] || 0) > 0;
            const hasNote = item.note && item.note.trim().length > 0;
            const wishCount = (item.wishes || []).length;
            const pendingWishes = (item.wishes || []).filter(
              (w: Wish) => w.status === "pending",
            ).length;

            const showPills = isSelected;

            return (
              <div>
                <div
                  style={
                    isSelected
                      ? {
                          ...itemRowBase,
                          background: "rgba(0, 122, 255, 0.06)",
                          borderRadius: "8px",
                        }
                      : itemRowBase
                  }
                >
                  {/* Item text or inline edit */}
                  {isEditing ? (
                    <div style={{ display: "flex", gap: "6px", flex: "1", alignItems: "center" }}>
                      <ct-input
                        $value={editingText}
                        style={{ flex: "1", fontSize: "14px", borderRadius: "8px" }}
                      />
                      <div
                        onClick={saveEdit}
                        style={{
                          ...iconBtn,
                          background: "rgba(52, 199, 89, 0.12)",
                          color: color.green,
                          fontSize: "12px",
                          fontWeight: "700",
                        }}
                      >
                        OK
                      </div>
                      <div
                        onClick={cancelEdit}
                        style={{
                          ...iconBtn,
                          background: "rgba(255, 59, 48, 0.12)",
                          color: color.red,
                          fontSize: "16px",
                        }}
                      >
                        x
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        flex: "1",
                        fontSize: "13px",
                        color: color.label,
                        cursor: "pointer",
                        overflow: "hidden" as const,
                        textOverflow: "ellipsis" as const,
                        whiteSpace: "nowrap" as const,
                      }}
                      onClick={() => selectItem.send({ id: item.id })}
                    >
                      {item.text}
                    </div>
                  )}

                  {/* Note pill — visible on hover/select or when note exists */}
                  {showPills || hasNote ? (
                    <span
                      onClick={() => openNote.send({ id: item.id, note: item.note })}
                      style={{
                        ...iconBtn,
                        color: hasNote ? color.blue : color.tertiaryLabel,
                        background: hasNote ? "rgba(0, 122, 255, 0.12)" : color.fillPrimary,
                        cursor: "pointer",
                      }}
                    >
                      note
                    </span>
                  ) : null}

                  {/* Wish pill — visible on hover/select or when wishes exist */}
                  {showPills || wishCount > 0 ? (
                    <span
                      onClick={() => openWishes.send({ id: item.id })}
                      style={{
                        ...iconBtn,
                        color: pendingWishes > 0 ? color.orange : wishCount > 0 ? color.green : color.tertiaryLabel,
                        background:
                          pendingWishes > 0
                            ? "rgba(255, 149, 0, 0.12)"
                            : wishCount > 0
                              ? "rgba(52, 199, 89, 0.12)"
                              : color.fillPrimary,
                        cursor: "pointer",
                      }}
                    >
                      {wishCount > 0 ? wishCount + " wish" : "wish"}
                    </span>
                  ) : null}

                  {/* Drill-in chevron */}
                  {hasChildren ? (
                    <span
                      onClick={() => drillIn.send({ id: item.id, text: item.text })}
                      style={{
                        fontSize: "14px",
                        color: color.tertiaryLabel,
                        flexShrink: "0",
                        cursor: "pointer",
                        padding: "0 4px",
                      }}
                    >
                      {">"}
                    </span>
                  ) : null}
                </div>

                {/* Selected item actions */}
                {isSelected && !isEditing ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      padding: "6px 12px 10px",
                      flexWrap: "wrap" as const,
                    }}
                  >
                    <div
                      onClick={() => startEdit.send({ id: item.id, text: item.text })}
                      style={{
                        padding: "4px 12px",
                        borderRadius: "100px",
                        fontSize: "11px",
                        fontWeight: "600",
                        background: "rgba(0, 122, 255, 0.12)",
                        color: color.blue,
                        cursor: "pointer",
                      }}
                    >
                      Edit
                    </div>
                    <div
                      onClick={() => drillIn.send({ id: item.id, text: item.text })}
                      style={{
                        padding: "4px 12px",
                        borderRadius: "100px",
                        fontSize: "11px",
                        fontWeight: "600",
                        background: "rgba(175, 82, 222, 0.12)",
                        color: color.purple,
                        cursor: "pointer",
                      }}
                    >
                      Sub-items
                    </div>
                    <div
                      onClick={() => deleteItem.send({ id: item.id })}
                      style={{
                        padding: "4px 12px",
                        borderRadius: "100px",
                        fontSize: "11px",
                        fontWeight: "600",
                        background: "rgba(255, 59, 48, 0.12)",
                        color: color.red,
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* ===== Note Modal ===== */}
          <ct-modal
            $open={computed(() => noteEditId.get() !== "")}
            dismissable
            size="md"
            onct-modal-close={closeNote}
          >
            <span slot="header">
              {noteItem ? "Note: " + noteItem.text : "Note"}
            </span>
            <ct-textarea
              $value={noteEditText}
              placeholder="Add notes..."
              rows={6}
              style={{ width: "100%", resize: "vertical" }}
            />
            <ct-hstack
              slot="footer"
              gap="3"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button variant="ghost" onClick={closeNote}>
                Cancel
              </ct-button>
              <ct-button variant="primary" onClick={saveNote}>
                Save Note
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* ===== Wish Modal ===== */}
          <ct-modal
            $open={computed(() => wishViewId.get() !== "")}
            dismissable
            size="md"
            onct-modal-close={closeWishes}
          >
            <span slot="header">
              {wishItem ? "Wishes: " + wishItem.text : "Wishes"}
            </span>
            <div>
              {/* Add wish input */}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  marginBottom: "16px",
                  alignItems: "center",
                }}
              >
                <ct-input
                  $value={wishDraft}
                  placeholder="Make a wish..."
                  style={{ flex: "1", fontSize: "14px", borderRadius: "10px" }}
                />
                <div
                  onClick={addWish}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "100px",
                    fontSize: "13px",
                    fontWeight: "600",
                    background: color.indigo,
                    color: "#fff",
                    cursor: "pointer",
                    flexShrink: "0",
                  }}
                >
                  Send
                </div>
              </div>

              {/* Existing wishes */}
              {wishItem && (wishItem.wishes || []).length > 0 ? (
                <div>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      color: color.secondaryLabel,
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.5px",
                      marginBottom: "8px",
                    }}
                  >
                    {"Wishes (" + (wishItem.wishes || []).length + ")"}
                  </div>
                  {(wishItem.wishes || []).map((w: Wish, wi: number) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 0",
                        borderBottom: "0.5px solid " + color.separator,
                      }}
                    >
                      <div
                        onClick={() =>
                          toggleWishStatus.send({
                            itemId: wishViewId.get(),
                            wishIdx: wi,
                          })
                        }
                        style={{
                          width: "20px",
                          height: "20px",
                          borderRadius: "4px",
                          border:
                            w.status === "done"
                              ? "2px solid " + color.green
                              : "2px solid " + color.tertiaryLabel,
                          background:
                            w.status === "done"
                              ? "rgba(52, 199, 89, 0.12)"
                              : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          flexShrink: "0",
                          fontSize: "12px",
                          color: color.green,
                        }}
                      >
                        {w.status === "done" ? "v" : ""}
                      </div>
                      <div style={{ flex: "1" }}>
                        <div
                          style={{
                            fontSize: "13px",
                            color:
                              w.status === "done"
                                ? color.tertiaryLabel
                                : color.label,
                            textDecoration:
                              w.status === "done" ? "line-through" : "none",
                          }}
                        >
                          {w.text}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: color.tertiaryLabel,
                            marginTop: "2px",
                          }}
                        >
                          {w.createdAt.substring(0, 10)}
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: "600",
                          color:
                            w.status === "pending" ? color.orange : color.green,
                          padding: "2px 8px",
                          borderRadius: "100px",
                          background:
                            w.status === "pending"
                              ? "rgba(255, 149, 0, 0.12)"
                              : "rgba(52, 199, 89, 0.12)",
                          flexShrink: "0",
                        }}
                      >
                        {w.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {wishItem && (wishItem.wishes || []).length === 0 ? (
                <div
                  style={{
                    fontSize: "13px",
                    color: color.tertiaryLabel,
                    textAlign: "center" as const,
                    padding: "12px 0",
                  }}
                >
                  No wishes yet
                </div>
              ) : null}
            </div>
            <ct-hstack
              slot="footer"
              gap="3"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button variant="primary" onClick={closeWishes}>
                Done
              </ct-button>
            </ct-hstack>
          </ct-modal>
        </div>
      );
    }),
  };
});

export default GTDProjects;
