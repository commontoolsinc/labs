/// <cts-enable />
import { cell, Default, NAME, recipe, UI } from "commontools";
import AisleSortedList from "./aisle-sorted-shopping-list.tsx";

const KROGER_OUTLINE = `# Aisle 1 - Produce
Fresh fruits, vegetables, salads, herbs
# Aisle 2 - Dairy
Milk, cheese, yogurt, butter
# Aisle 3 - Meat
Beef, pork, chicken, fish
# Aisle 4 - Bakery
Bread, pastries, cookies, cakes
# Aisle 5 - Frozen Foods
Frozen vegetables, frozen meat, frozen fish, frozen desserts
`;

interface TestInput {
  testData: Default<boolean, true>;
}

export default recipe<TestInput, TestInput>(
  "Test Aisle Sorted",
  ({ testData }) => {
    const items = cell([
      { title: "milk", done: false },
      { title: "apples", done: false },
      { title: "frozen vegetables", done: false },
      { title: "eggs", done: false },
      { title: "bread", done: false },
      { title: "butter", done: false },
      { title: "cheese", done: false },
      { title: "yogurt", done: false },
      { title: "milk", done: false },
      { title: "apples", done: false },
    ]);

    const result = AisleSortedList({
      items,
      storeOutline: KROGER_OUTLINE,
      storeName: "Kroger Main St",
    });

    return {
      [NAME]: "Test Aisle Sorted",
      [UI]: <div>{result}</div>,
      testData,
    };
  },
);
