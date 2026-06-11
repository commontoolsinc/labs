import { computed, type Default, pattern } from "commonfabric";

// FIXTURE: default-survives-capture-shrink
// Verifies: Default<…> annotations on properties survive capture shrinking
// as alias references, so the injected capture schemas keep their
// `"default"` values. When the shrunken type node expands the alias
// structurally (`boolean | (false & { [DEFAULT_MARKER]: false })`), the
// schema generator no longer recognizes the spelling and silently drops
// the default — and literal default values can widen away entirely
// (`Default<string, "">` → `{ [DEFAULT_MARKER]: string }`).
interface Item {
  done: boolean | Default<false>;
  label: Default<string, "">;
}

interface Input {
  items: Item[];
}

export default pattern<Input>(({ items }) => {
  const firstDone = computed(() => items[0]?.done === true);
  const firstLabelEmpty = computed(() => items[0]?.label === "");
  return { firstDone, firstLabelEmpty };
});
