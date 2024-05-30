import { makeLattice, inferState, type Binding, BOTTOM, TOP } from "./ifc.s";

// Example state and bindings
const initialState = {
  bar: {
    baz: {
      label: { integrity: "trusted cloud", confidentiality: "trusted cloud" },
    },
    zab: {
      label: { integrity: "public", confidentiality: "public" },
    },
  },
};

const bindings: Binding[] = [{ in: ["bar.baz", "bar.zab"], out: ["foo"] }];

const lattice = makeLattice({
  [BOTTOM]: ["public"],
  public: ["trusted cloud"],
  "trusted cloud": ["cc", "openai", "anthropic"],
  cc: ["ondevice"],
  [TOP]: [],
});

// Infer the state
const inferredState = inferState(initialState, bindings, lattice);

// Accessing the labels
console.log(inferredState); // Output will reflect the inferred labels based on the lattice
