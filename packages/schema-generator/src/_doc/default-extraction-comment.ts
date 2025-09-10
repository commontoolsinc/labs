/**
 * Default<T, V> — extracting a JSON default from a TypeNode
 *
 * Why this exists:
 * - Default<T, V> erases at the type level to just T, so V is not
 *   recoverable from a resolved ts.Type. The only reliable place to see V
 *   is the AST TypeNode at the usage site (context.typeNode).
 * - JSON Schema needs a runtime JSON value for "default". We therefore
 *   interpret the TypeNode for V and reconstruct an equivalent JSON value.
 *
 * Strategy (node-first, safe, deterministic):
 * 1) Handle literal type nodes directly:
 *    - "x", 42, true, false, null → corresponding JSON primitives
 * 2) Handle tuple type nodes as arrays:
 *    - ["a", "b"] → recursively convert each element to JSON values
 * 3) Handle type literal nodes as objects:
 *    - { theme: "dark"; count: 10 } → walk members and recursively convert
 *      each member type to build a JSON object
 * 4) Handle keyword nodes:
 *    - null → null
 *    - undefined → undefined (note: we do not emit a "default" if undefined)
 *
 * Fallbacks (used when V is not a simple literal/tuple/type-literal node):
 * - Ask the checker for the type and try literal flags again (string/number/
 *   boolean/null/undefined).
 * - As a last resort, interpret the type’s string representation in simple,
 *   safe cases:
 *     • Arrays that look like ["a", "b"]: try JSON.parse; if that fails,
 *       use a tiny parser that splits basic cases.
 *     • Objects that look like { theme: "dark", count: 10 }: coerce to JSON
 *       (quote keys, normalize quotes) and try JSON.parse; if that fails,
 *       use a simple key:value splitter.
 *
 * Safety and constraints:
 * - We never evaluate code. We only interpret specific TypeNode shapes.
 * - Node-first extraction keeps results stable across hosts and minimal
 *   compiler environments. The string-based fallback is conservative and
 *   only for simple patterns to preserve common defaults (arrays/objects).
 * - When V is aliased (e.g., type Items = ["a","b"]; Default<string[],
 *   Items>), V may not be a direct literal node. Fallbacks allow us to
 *   reconstruct a JSON value without evaluating arbitrary expressions.
 *
 * Examples:
 * - Default<number, 5> → { type: "number", default: 5 }
 * - Default<string[], ["a", "b"]> → { type: "array", items:
 *   { type: "string" }, default: ["a", "b"] }
 * - Default<{ theme: string; count: number }, { theme: "dark"; count: 10 }>
 *   → object schema for T with default { theme: "dark", count: 10 }
 * - Default<Date, "2023-01-01T00:00:00.000Z"> → { type: "string",
 *   format: "date-time", default: "2023-01-01T00:00:00.000Z" }
 *
 * Trade-offs and future directions:
 * - We could simplify by supporting only literal/tuple/type-literal nodes and
 *   rejecting everything else, at the cost of breaking some alias-driven
 *   patterns.
 * - If the AST transformer later captures constant expressions for defaults,
 *   more evaluation could move to the transformer and this logic could be
 *   further reduced.
 */
