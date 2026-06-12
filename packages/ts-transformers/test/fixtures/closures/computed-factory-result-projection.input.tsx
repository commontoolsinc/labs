import { computed, Default, NAME, pattern } from "commonfabric";

interface ListItem {
  id: string;
  done: boolean | Default<false>;
  label: Default<string, "">;
  // deno-lint-ignore no-explicit-any
  [extra: string]: any;
}

interface ListOutput {
  [NAME]: string;
  items: ListItem[];
  total: number;
}

interface ListInput {
  seed?: Default<string, "">;
}

const List = pattern<ListInput, ListOutput>(() => {
  const items: ListItem[] = [];
  return {
    [NAME]: "list",
    items,
    total: computed(() => items.length),
  };
});

// FIXTURE: computed-factory-result-projection
// Pins lift-capture shrinking through an UNSTRIPPED factory result type (the
// capture's inferred type node prints named interface references, which carry
// their symbol only on the synthesized identifier — see
// tryGetDeclaredTypeFromSynthesizedName). Two behaviors guarded here:
//   1. A declared-key read projects through the named reference and keeps the
//      authored `Default<...>` alias, so the schema keeps `"default"` (and
//      the projected `Default<string, "">` literal prints from its own text;
//      the cross-file variant of that print is unit-tested next to
//      cloneTypeNodeDeepForEmission).
//   2. An index-signature key read (`priority`) must NOT be marked required —
//      items that legitimately omit the key would fail schema validation
//      (main regression: editable-list assert_extra_passthrough).
export default pattern(() => {
  const list = List({});

  const firstDone = computed(() => list.items[0]?.done === true);
  const labelGamma = computed(() => list.items[2]?.label === "Gamma");
  const extraPassthrough = computed(() => list.items[2]?.priority === 9);

  return {
    firstDone,
    labelGamma,
    extraPassthrough,
  };
});
