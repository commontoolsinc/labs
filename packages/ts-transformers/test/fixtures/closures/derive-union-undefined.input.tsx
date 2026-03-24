/// <cts-enable />
import { Writable, derive, pattern } from "commonfabric";

interface Config {
  required: number;
  unionUndefined: number | undefined;
}

// FIXTURE: derive-union-undefined
// Verifies: captured properties with `number | undefined` union types produce correct schemas
//   derive(value, fn) → derive(schema, schema, { value, config: { required, unionUndefined } }, fn)
// Context: `unionUndefined` schema is `type: ["number", "undefined"]`; `required` is plain `number`
export default pattern((config: Config) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => 
    v.get() + config.required + (config.unionUndefined ?? 0)
  );

  return result;
});
