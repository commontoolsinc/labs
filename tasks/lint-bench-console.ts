/// <reference lib="deno.unstable" />

/**
 * A lint rule that keeps the diagnostics a `*.bench.ts` file prints on a stream
 * that survives a `deno bench --json` run.
 *
 * The Benchmarks workflow sends stdout to `bench-results/results.json` and tees
 * stderr to `bench-results/diagnostics.log`. Two things follow, and this rule
 * enforces both:
 *
 *   - A `console` method that writes to stdout puts non-JSON text into
 *     `results.json`, which invalidates the artifact for every benchmark in the
 *     run, not just the file that printed it. Only `error`, `warn`, `trace`,
 *     and `assert` write to stderr, so those four are the whole of what a
 *     benchmark file may call outside a body.
 *   - The JSON reporter captures whatever a benchmark body writes through
 *     `console`, on either stream, and drops it. A diagnostic written that way
 *     reaches neither the artifact nor the workflow log. A write straight to
 *     `Deno.stderr` inside a body passes through.
 *
 * A `console` call counts as a body diagnostic when it sits inside a
 * `Deno.bench(...)` argument, and also when it sits in a function of the same
 * file that a benchmark body calls, however many hops away. That second form is
 * how the rule reads a file whose bodies print through a shared reporting
 * helper. A helper in another module is beyond what one file's syntax tree
 * shows; write those with `Deno.stderr` too.
 *
 * See docs/development/BENCHMARKS.md.
 */

/**
 * The `console` methods that write to stderr. Everything else on `console`
 * either writes to stdout or writes nothing, and naming the short list this way
 * round is what makes the rule safe: a method nobody here has heard of is
 * rejected rather than allowed through.
 */
const STDERR_METHODS: ReadonlySet<string> = new Set([
  "assert",
  "error",
  "trace",
  "warn",
]);

const BODY_MESSAGE =
  "A `console` call that runs in a benchmark body is captured by the `deno " +
  "bench --json` reporter and never reaches stderr. Write the diagnostic with " +
  "`Deno.stderr.writeSync(...)` instead. See docs/development/BENCHMARKS.md.";

const STDOUT_MESSAGE =
  "A benchmark file may use only the `console` methods that write to stderr: " +
  "`error`, `warn`, `trace`, `assert`. Any other one risks a line on stdout, " +
  "which carries the `deno bench --json` report, where one stray line " +
  "invalidates the results artifact for every benchmark in the run. Use " +
  "`console.error`, or `Deno.stderr.writeSync(...)`. See " +
  "docs/development/BENCHMARKS.md.";

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** The shape this rule reads off a node, on top of the type tag. */
interface BenchNode {
  readonly type: string;
  readonly range: readonly [number, number];
  readonly id?: { readonly type: string; readonly name?: string };
  readonly init?: BenchNode | null;
  readonly callee: {
    readonly type: string;
    readonly name?: string;
    readonly computed?: boolean;
    readonly object?: { readonly type: string; readonly name?: string };
    readonly property?: { readonly type: string; readonly name?: string };
  };
}

/**
 * Returns the method name when `node` is a call on the `console` global, and
 * undefined otherwise. A local binding named `console` would read the same way;
 * no benchmark file shadows the global.
 */
function consoleMethod(node: BenchNode): string | undefined {
  const { callee } = node;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.object?.type !== "Identifier") return undefined;
  if (callee.object.name !== "console") return undefined;
  if (callee.property?.type !== "Identifier") return undefined;
  return callee.property.name;
}

/** Returns true when `node` is a `Deno.bench(...)` call. */
function isBenchCall(node: BenchNode): boolean {
  const { callee } = node;
  return callee.type === "MemberExpression" && !callee.computed &&
    callee.object?.type === "Identifier" && callee.object.name === "Deno" &&
    callee.property?.type === "Identifier" && callee.property.name === "bench";
}

/** The name a plain `name(...)` call names, if the call has that form. */
function calledName(node: BenchNode): string | undefined {
  const { callee } = node;
  return callee.type === "Identifier" ? callee.name : undefined;
}

/** One function body, plus the module body, which the rule treats as one. */
interface Scope {
  /** Names this body calls as plain `name(...)` calls. */
  readonly calls: Set<string>;

  /** The `console` calls written directly in this body. */
  readonly consoleCalls: { node: Deno.lint.Node; method: string }[];

  /** True when this function was written inside a `Deno.bench(...)` call. */
  readonly inBench: boolean;
}

export default {
  name: "cf-bench",
  rules: {
    "no-lost-diagnostics": {
      create(context) {
        if (!context.filename.endsWith(".bench.ts")) return {};

        const moduleScope: Scope = {
          calls: new Set(),
          consoleCalls: [],
          inBench: false,
        };
        const scopes: Scope[] = [moduleScope];
        const stack: Scope[] = [moduleScope];
        // Functions reachable by name from a benchmark body. A function
        // expression bound to a variable takes that variable's name, which the
        // declarator records before the traversal descends into the function.
        const byName = new Map<string, Scope>();
        const pendingNames = new Map<string, string>();
        // Counts the `Deno.bench(...)` calls the traversal is currently inside.
        let benchDepth = 0;

        const rangeKey = (node: BenchNode) => node.range.join(":");

        return {
          VariableDeclarator(node) {
            const declarator = node as unknown as BenchNode;
            const init = declarator.init;
            if (!init || !FUNCTION_TYPES.has(init.type)) return;
            if (declarator.id?.type !== "Identifier") return;
            const name = declarator.id.name;
            if (name !== undefined) pendingNames.set(rangeKey(init), name);
          },

          ArrowFunctionExpression: enterFunction,
          FunctionDeclaration: enterFunction,
          FunctionExpression: enterFunction,
          "ArrowFunctionExpression:exit": exitFunction,
          "FunctionDeclaration:exit": exitFunction,
          "FunctionExpression:exit": exitFunction,

          CallExpression(node) {
            const call = node as unknown as BenchNode;
            if (isBenchCall(call)) {
              benchDepth += 1;
              return;
            }
            const scope = stack[stack.length - 1];
            const name = calledName(call);
            if (name !== undefined) scope.calls.add(name);
            const method = consoleMethod(call);
            if (method === undefined) return;
            if (benchDepth > 0) {
              // Written inside the `Deno.bench(...)` call itself, whether or
              // not a nested function encloses it.
              context.report({ node, message: BODY_MESSAGE });
              return;
            }
            scope.consoleCalls.push({ node, method });
          },

          "CallExpression:exit"(node) {
            if (isBenchCall(node as unknown as BenchNode)) benchDepth -= 1;
          },

          "Program:exit"() {
            // Walk out from the bodies, through the names they call, to every
            // function of this file that a body can reach.
            const reached = new Set<Scope>();
            const queue = scopes.filter((scope) => scope.inBench);
            while (queue.length > 0) {
              const scope = queue.pop()!;
              for (const name of scope.calls) {
                const target = byName.get(name);
                if (target === undefined || reached.has(target)) continue;
                reached.add(target);
                queue.push(target);
              }
            }
            for (const scope of scopes) {
              for (const { node, method } of scope.consoleCalls) {
                if (reached.has(scope)) {
                  context.report({ node, message: BODY_MESSAGE });
                } else if (!STDERR_METHODS.has(method)) {
                  context.report({ node, message: STDOUT_MESSAGE });
                }
              }
            }
          },
        };

        function enterFunction(node: Deno.lint.Node) {
          const fn = node as unknown as BenchNode;
          const scope: Scope = {
            calls: new Set(),
            consoleCalls: [],
            inBench: benchDepth > 0,
          };
          scopes.push(scope);
          stack.push(scope);
          const name = fn.id?.type === "Identifier"
            ? fn.id.name
            : pendingNames.get(rangeKey(fn));
          if (name !== undefined) byName.set(name, scope);
        }

        function exitFunction() {
          stack.pop();
        }
      },
    },
  },
} satisfies Deno.lint.Plugin;
