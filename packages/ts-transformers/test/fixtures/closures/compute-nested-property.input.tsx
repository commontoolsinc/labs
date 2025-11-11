/// <cts-enable />
import { cell, compute } from "commontools";

export default function TestComputeNestedProperty() {
  const counter = cell({ count: 0 });

  const doubled = compute(() => {
    const current = counter.get();
    return current.count * 2;
  });

  return doubled;
}
