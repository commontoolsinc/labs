import { toSchema } from "commonfabric";

interface Config {
  count: number;
  label: string;
}

const configSchema = toSchema<Config>({
  // Parentheses are a distinct AST node carrying no meaning. Evaluating the
  // options object without seeing through them drops the property entirely --
  // for EVERY option type, not just numbers.
  description: ("a description"),
  "default": {
    count: (1),
    label: ("text"),
  },
  examples: [("one"), (2)],
});
// FIXTURE: parenthesized-options
// Verifies: a parenthesized value in the toSchema options object survives,
// whatever its type. Each of these properties was silently dropped before --
// including plainly non-numeric ones, which is why the unwrapping belongs in
// the options evaluator rather than in its numeric special case.
export { configSchema };
