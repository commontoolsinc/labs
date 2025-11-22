/// <cts-enable />
import { cell } from "commontools";

export default function TestLiteralWidenNestedStructure() {
  const _nested = cell({
    users: [
      { id: 1, name: "Alice", active: true },
      { id: 2, name: "Bob", active: false }
    ],
    count: 2
  });

  return null;
}
