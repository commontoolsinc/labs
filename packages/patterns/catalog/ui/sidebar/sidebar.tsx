/// <cts-enable />
import { NAME, pattern, Stream, UI, type VNode } from "commontools";
import { Category } from "../../catalog.tsx";
import { CategoryRow } from "./category-row.tsx";
import { CategoryRowItem } from "./category-row-item.tsx";

interface SidebarInput {
  selected: string;
  categories: Category[];
  onSelect: Stream<{ id: string }>;
}

interface SidebarOutput {
  [NAME]: string;
  [UI]: VNode;
}

const styles = {
  root: {
    width: "220px",
    backgroundColor: "#f6f7f9",
    borderRight: "1px solid #e6e9ed",
    overflowY: "auto",
    flexShrink: "0",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  header: {
    padding: "16px",
    borderBottom: "1px solid #e6e9ed",
  },
  headerTitle: {
    fontSize: "14px",
    fontWeight: "700",
    color: "#2e3438",
    letterSpacing: "-0.01em",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
};

export const Sidebar = pattern<SidebarInput, SidebarOutput>(
  ({ selected, categories, onSelect }) => {
    return {
      [NAME]: "Sidebar",
      [UI]: (
        <div style={styles.root}>
          {/* Header area */}
          <div style={styles.header}>
            <div style={styles.headerTitle}>
              Component Catalog
            </div>
          </div>

          {/* Content area */}
          <div style={styles.content}>
            {categories.map((category) => (
              <CategoryRow name={category.name}>
                {/* TODO: See if we can improve our types for arrays of VNode children. */}
                {/* This fragment feels uncessary */}
                <>
                  {category.items.map((item) => (
                    <CategoryRowItem
                      selected={selected}
                      item={item}
                      onSelect={onSelect}
                    />
                  ))}
                </>
              </CategoryRow>
            ))}
          </div>
        </div>
      ),
    };
  },
);
