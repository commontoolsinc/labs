/**
 * The two debug string renderers, run over the cases recorded as files in
 * `value-debug-cases/`. Each file holds three items separated by blank lines:
 * a JavaScript expression which produces a value, the value's
 * `toIndentedDebugString()` rendering, and its `toCompactDebugString()`
 * rendering at a maximum length of 100. A recorded rendering is a fact about
 * the renderer, to be read as such when it changes.
 *
 * The expression is evaluated with every `FabricInstance` and
 * `FabricPrimitive` class in scope under its own name, and nothing else beyond
 * the language.
 *
 * To rewrite each file's recorded renderings from the actual ones, run this
 * from the package directory:
 *
 * ```
 * UPDATE_GOLDENS=1 deno test --allow-read --allow-write --allow-env \
 *   test/value-debug-cases.test.ts
 * ```
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as fabricInstances from "@/fabric-instances/index.ts";
import * as fabricPrimitives from "@/fabric-primitives/index.ts";
import { toCompactDebugString, toIndentedDebugString } from "@/value-debug.ts";

/** Directory holding the case files. */
const CASES_DIR = new URL("./value-debug-cases/", import.meta.url);

/** Maximum length passed to `toCompactDebugString()`. */
const COMPACT_MAX_LENGTH = 100;

/** Whether to rewrite the recorded renderings instead of checking them. */
const UPDATE_GOLDENS = (() => {
  const query = Deno.permissions.querySync({
    name: "env",
    variable: "UPDATE_GOLDENS",
  });
  return (query.state === "granted") &&
    (Deno.env.get("UPDATE_GOLDENS") === "1");
})();

/** Names and values in scope when a case's expression is evaluated. */
const SCOPE: Record<string, unknown> = Object.fromEntries(
  [...Object.entries(fabricInstances), ...Object.entries(fabricPrimitives)]
    .filter(([, value]) =>
      typeof value === "function" && /^Fabric/.test(
        (value as { name: string }).name,
      )
    ),
);

/** Evaluates a case's expression, producing the value it describes. */
function evaluateExpression(expression: string): unknown {
  const names = Object.keys(SCOPE);
  const values = names.map((name) => SCOPE[name]);
  const fn = new Function(
    ...names,
    `"use strict";\nreturn (\n${expression}\n);`,
  );
  return fn(...values);
}

/** Splits a case file into its expression and its two recorded renderings. */
function parseCaseFile(text: string): {
  expression: string;
  indented: string;
  compact: string;
} {
  const [expression = "", indented = "", compact = ""] = text.trimEnd().split(
    "\n\n",
  );
  return { expression, indented, compact };
}

/** Names of the case files, sorted for a stable test order. */
const caseNames = [...Deno.readDirSync(CASES_DIR)]
  .filter((entry) => entry.isFile && entry.name.endsWith(".txt"))
  .map((entry) => entry.name.replace(/\.txt$/, ""))
  .sort();

describe("value-debug-cases", () => {
  for (const name of caseNames) {
    it(`renders \`${name}\` as recorded`, async () => {
      const url = new URL(`${name}.txt`, CASES_DIR);
      const recorded = parseCaseFile(await Deno.readTextFile(url));
      const value = evaluateExpression(recorded.expression);
      const actual = {
        indented: toIndentedDebugString(value),
        compact: toCompactDebugString(value, COMPACT_MAX_LENGTH),
      };

      if (UPDATE_GOLDENS) {
        await Deno.writeTextFile(
          url,
          `${recorded.expression}\n\n${actual.indented}\n\n${actual.compact}\n`,
        );
        return;
      }

      expect(actual.indented).toBe(recorded.indented);
      expect(actual.compact).toBe(recorded.compact);
    });
  }
});
