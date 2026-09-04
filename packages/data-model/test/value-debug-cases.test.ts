/**
 * The two debug string renderers, run over the cases recorded as files in
 * `value-debug-cases/`. A file opens with a JavaScript expression which
 * produces a plain object, each of whose properties is one case: the key
 * labels it, and the value is what gets rendered, on its own. After a blank
 * line, the file records one section per property, the sections separated by
 * blank lines: the label followed by a colon on a line of its own, then the
 * value's `toCompactDebugString()` rendering, whole, then its
 * `toIndentedDebugString()` rendering, which can run to several lines. A
 * recorded rendering is a fact about the renderer, to be read as such when it
 * changes. What `maxLength` does to a compact rendering is
 * `value-debug.test.ts`'s to check, so no case here is cut by one.
 *
 * The expression is evaluated with every `FabricInstance` and
 * `FabricPrimitive` class in scope under its own name, along with the three
 * abstract base classes and the realm codec's binding symbol, so that a case
 * can define a class of its own; nothing else beyond the language is in
 * scope.
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

import { REALM_CODEC } from "@/codec-interface/interface.ts";
import * as fabricInstances from "@/fabric-instances/index.ts";
import * as fabricPrimitives from "@/fabric-primitives/index.ts";
import {
  FabricInstance,
  FabricPrimitive,
  FabricSpecialObject,
} from "@/interface.ts";
import { toCompactDebugString, toIndentedDebugString } from "@/value-debug.ts";

/** Directory holding the case files. */
const CASES_DIR = new URL("./value-debug-cases/", import.meta.url);

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
const SCOPE: Record<string, unknown> = Object.fromEntries([
  ...[...Object.entries(fabricInstances), ...Object.entries(fabricPrimitives)]
    .filter(([, value]) =>
      typeof value === "function" && /^Fabric/.test(
        (value as { name: string }).name,
      )
    ),
  ...Object.entries({
    FabricInstance,
    FabricPrimitive,
    FabricSpecialObject,
    REALM_CODEC,
  }),
]);

/**
 * Evaluates a case's expression, producing the cases it describes.
 *
 * @throws {Error} if the expression produces other than a plain object.
 */
function evaluateExpression(expression: string): Record<string, unknown> {
  const names = Object.keys(SCOPE);
  const values = names.map((name) => SCOPE[name]);
  const fn = new Function(
    ...names,
    `"use strict";\nreturn (\n${expression}\n);`,
  );
  const result = fn(...values);

  if (
    (result === null) || (typeof result !== "object") ||
    (Object.getPrototypeOf(result) !== Object.prototype)
  ) {
    const rendered = toCompactDebugString(result, { maxLength: 60 });
    throw new Error(
      `Case expression must produce a plain object; got ${rendered}`,
    );
  }

  return result;
}

/**
 * Splits a case file into its expression and its recorded sections, one per
 * case. The expression runs to the first blank line, and the sections are
 * what follow it, separated by blank lines; a rendering never holds a blank
 * line, so the split is unambiguous. A file with nothing but an expression is
 * accepted when the recordings are about to be rewritten.
 */
function parseCaseFile(text: string): {
  expression: string;
  sections: string[];
} {
  const [expression = "", ...sections] = text.trimEnd().split("\n\n");

  if ((sections.length === 0) && !UPDATE_GOLDENS) {
    throw new Error("Case file records no sections.");
  }

  return { expression, sections };
}

/**
 * Renders one case as its recorded section: the label and a colon, the
 * compact rendering, and the indented rendering, each starting on a line of
 * its own.
 */
function renderSection(label: string, value: unknown): string {
  const compact = toCompactDebugString(value);
  const indented = toIndentedDebugString(value);
  return `${label}:\n${compact}\n${indented}`;
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
      const cases = evaluateExpression(recorded.expression);
      const actual = Object.entries(cases).map(([label, value]) =>
        renderSection(label, value)
      );

      if (UPDATE_GOLDENS) {
        await Deno.writeTextFile(
          url,
          `${recorded.expression}\n\n${actual.join("\n\n")}\n`,
        );
        return;
      }

      expect(actual).toEqual(recorded.sections);
    });
  }
});
