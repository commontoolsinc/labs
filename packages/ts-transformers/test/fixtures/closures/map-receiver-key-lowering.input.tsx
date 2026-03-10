/// <cts-enable />
import { pattern } from "commontools";

interface Item {
  subItems: Array<{ value: string }>;
}

interface Input {
  items: Item[];
}

const _p = pattern<Input>(({ items }) =>
  items.map((item) => item.subItems.map((subItem) => subItem.value))
);
