/// <cts-enable />
import { cell } from "commontools";

export default function TestCollectionsNestedObjects() {
  // Nested objects
  const _nested = cell({
    user: {
      name: "Alice",
      age: 30,
      address: {
        street: "123 Main St",
        city: "NYC"
      }
    },
    timestamp: 1234567890
  });

  return _nested;
}
