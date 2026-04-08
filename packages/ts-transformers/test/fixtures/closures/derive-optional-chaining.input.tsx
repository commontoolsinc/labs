import { Writable, derive, pattern } from "commonfabric";

interface Config {
  multiplier?: number;
}

// FIXTURE: derive-optional-chaining
// Verifies: an optional property captured via nullish coalescing is extracted with a union type schema
//   derive(value, fn) → derive(schema, schema, { value, config: { multiplier: ... } }, fn)
// Context: `config.multiplier` is `number | undefined`; schema uses `type: ["number", "undefined"]`
export default pattern((config: Config) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => v.get() * (config.multiplier ?? 1));

  return result;
});
