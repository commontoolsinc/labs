import { Writable, derive, pattern } from "commonfabric";

interface State {
  config: {
    multiplier: number;
  };
}

// FIXTURE: derive-nested-property
// Verifies: a nested property path on a captured object produces a nested capture structure
//   derive(value, fn) → derive(schema, schema, { value, state: { config: { multiplier: ... } } }, fn)
// Context: `state.config.multiplier` is a two-level deep property access captured as a nested object
export default pattern((state: State) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => v.get() * state.config.multiplier);

  return result;
});
