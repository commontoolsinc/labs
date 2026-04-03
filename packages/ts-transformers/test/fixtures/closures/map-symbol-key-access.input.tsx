/// <cts-enable />
import { NAME, UI, pattern } from "commontools";

interface Entry {
  [NAME]: string;
  [UI]: string;
}

interface Input {
  items: Entry[];
}

// FIXTURE: map-symbol-key-access
// Verifies: .map() on reactive array is transformed when callback uses symbol key access
//   .map(fn) → .mapWithPattern(pattern(...), {})
//   item[NAME] → item.key(__ctHelpers.NAME), item[UI] → item.key(__ctHelpers.UI)
// Context: Symbol-keyed property access (NAME, UI) is lowered to .key() with helper references
const _p = pattern<Input>(({ items }) =>
  items.map((item) => ({ n: item[NAME], u: item[UI] }))
);
