import {
  makeLattice,
  inferLabels,
  type Node,
  type State,
  $label,
  BOTTOM,
  TOP,
} from "./ifc.ts";

// Example state and bindings
const initialState: State = {
  bar: {
    baz: {
      [$label]: {
        integrity: "trusted cloud",
        confidentiality: "trusted cloud",
      },
    },
    zab: {
      [$label]: { integrity: "public", confidentiality: "public" },
    },
  },
};

const bindings: Node[] = [{ in: ["bar.baz", "bar.zab"], out: ["foo"] }];

const lattice = makeLattice({
  [BOTTOM]: ["public"],
  public: ["trusted cloud"],
  "trusted cloud": ["cc", "openai", "anthropic"],
  cc: ["ondevice"],
  [TOP]: [],
});

// Infer the state
const inferredState = inferLabels(initialState, bindings, lattice);

// Accessing the labels
console.log(inferredState); // Output will reflect the inferred labels based on the lattice
