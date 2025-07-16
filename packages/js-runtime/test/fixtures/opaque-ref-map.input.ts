import { recipe, OpaqueRef } from "commontools";

interface TodoItem {
  title: string;
  done: boolean;
}

export default recipe<{ items: TodoItem[] }>("Test Map", ({ items }) => {
  // This should NOT be transformed to items.get().map()
  // because OpaqueRef has its own map method
  const mapped = items.map((item) => item.title);
  
  // This should also work without transformation
  const filtered = items.map((item, index) => ({
    ...item,
    position: index
  }));
  
  return { mapped, filtered };
});