/// <cts-enable />
import { computed, NAME, pattern, Stream, UI, type VNode } from "commonfabric";
import { type CategoryItem } from "../../catalog.tsx";

interface CategoryRowItemInput {
  selected: string;
  item: CategoryItem;
  onSelect: Stream<{ id: string }>;
}

interface CategoryRowItemOutput {
  [NAME]: string;
  [UI]: VNode;
}

const styles = {
  root: {
    padding: "4px 12px",
    margin: "1px 8px",
    borderRadius: "4px",
    fontSize: "13px",
    cursor: "pointer",
  },
};

export const CategoryRowItem = pattern<
  CategoryRowItemInput,
  CategoryRowItemOutput
>(
  ({ selected, item, onSelect }) => {
    const isActive = computed(() => selected === item.id);

    return {
      [NAME]: "CategoryRowItem",
      [UI]: (
        <div
          style={{
            ...styles.root,
            color: isActive ? "#1ea7fd" : "#2e3438",
            backgroundColor: isActive ? "#e8f4fd" : "transparent",
            fontWeight: isActive ? "600" : "400",
          }}
          onClick={() => onSelect.send({ id: item.id })}
        >
          {item.label}
        </div>
      ),
    };
  },
);
