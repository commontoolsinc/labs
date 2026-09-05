/// <reference lib="deno.unstable" />

/**
 * A lint rule that keeps `accessForTestingOnly` to the tests.
 *
 * The getter hands a test the `#` members a class otherwise keeps to itself;
 * "Making a private member reachable from a test" in
 * docs/development/DEVELOPMENT.md is where it is defined. The name is the
 * contract: what sits behind it is internals, free to change whenever the
 * class does, and the only code entitled to depend on them is the test written
 * against them. A read from anywhere else turns the getter into public API
 * under a name that says it is not. So the rule reports every access to the
 * name in a file that is not a test: `x.accessForTestingOnly`,
 * `x?.accessForTestingOnly`, `x["accessForTestingOnly"]`, and a destructuring
 * `{ accessForTestingOnly }`, the class's own methods included.
 *
 * A test, a benchmark, and the helpers and fixtures serving either are what
 * `test-files.ts` says they are, and the rule reads nothing in those. It also
 * reads nothing in the getter's own declaration, or in a type written
 * `C["accessForTestingOnly"]`, which is erased before anything runs. The rule
 * matches the name where it is written, and a reach that builds the name
 * rather than writing it — `Reflect.get(x, "accessFor" + "TestingOnly")` —
 * passes.
 */

import { dirname, fromFileUrl } from "@std/path";
import { isTestFile } from "./test-files.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** The getter's name, which is the whole of what the rule matches on. */
const ACCESSOR = "accessForTestingOnly";

const MESSAGE = "`accessForTestingOnly` hands a test a class's internals, " +
  "and only a test, a benchmark, or a file serving one may read it. Reach " +
  "what this needs through the class's public surface instead. See " +
  '"Making a private member reachable from a test" in ' +
  "docs/development/DEVELOPMENT.md.";

/** The shape this rule reads off a member name or a property key. */
interface KeyNode {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
}

/**
 * True when `key` is the getter's name as written: the identifier `x.name`
 * and `{ name }` use, or the string literal `x["name"]` and `{ "name": y }`
 * use. A computed identifier, `x[name]`, is a variable and not the name.
 */
function namesAccessor(key: KeyNode, computed: boolean): boolean {
  if (key.type === "Literal") return key.value === ACCESSOR;
  return !computed && key.type === "Identifier" && key.name === ACCESSOR;
}

export default {
  name: "cf-source",
  rules: {
    "no-access-for-testing-only": {
      create(context) {
        if (isTestFile(REPO_ROOT, context.filename)) return {};

        return {
          MemberExpression(node) {
            if (namesAccessor(node.property, node.computed)) {
              context.report({ node, message: MESSAGE });
            }
          },

          Property(node) {
            if (node.parent.type !== "ObjectPattern") return;
            if (namesAccessor(node.key, node.computed)) {
              context.report({ node, message: MESSAGE });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
