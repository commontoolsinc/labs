/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commonfabric";

interface CategoryRowInput {
  name: string;
  children?: VNode;
}

interface CategoryRowOutput {
  [NAME]: string;
  [UI]: VNode;
}

const styles = {
  heading: {
    padding: "4px 16px 6px",
    fontSize: "11px",
    fontWeight: "700",
    color: "#798186",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
};

export const CategoryRow = pattern<CategoryRowInput, CategoryRowOutput>(
  ({ name, children }) => {
    return {
      [NAME]: "CategoryRow",
      [UI]: (
        <div>
          <div style={styles.heading}>
            {name}
          </div>
          {children}
        </div>
      ),
    };
  },
);
