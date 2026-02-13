/// <cts-enable />
import { pattern } from "commontools";

interface TodoItem {
  title: string;
  done: boolean;
}

export default pattern<{ items: TodoItem[] }>("Test Map", ({ items }) => {
  // Map on opaque ref arrays should be transformed to mapWithPattern
  const mapped = items.map((item) => item.title);

  // This should also be transformed
  const filtered = items.map((item, index) => ({
    title: item.title,
    done: item.done,
    position: index,
  }));

  return { mapped, filtered };
});
