import { toSchema } from "commonfabric";

interface Config {
  sentinel: number;
  ratio: number;
  nan: number;
  inf: number;
  ninf: number;
  nzero: number;
  parenthesized: number;
}

const configSchema = toSchema<Config>({
  "default": {
    sentinel: -1,
    ratio: -0.5,
    nan: NaN,
    inf: Infinity,
    ninf: -Infinity,
    nzero: -0,
    // Parentheses carry no meaning, but they are a distinct AST node; without
    // unwrapping them this property is dropped like any other.
    parenthesized: (-1),
  },
  // The same unwrapping, on a value that is not a number at all.
  description: ("a description"),
});
// FIXTURE: numeric-option-defaults
// Verifies: the toSchema options object carries signed and non-finite numbers
// through to the emitted schema, and sees through parentheses. Recognizing only
// bare NumericLiteral drops each of these properties silently — a `-1` sentinel
// default just vanishes — and a value in parentheses is dropped whatever its
// type, which is why a plain string is among the cases here.
export { configSchema };
