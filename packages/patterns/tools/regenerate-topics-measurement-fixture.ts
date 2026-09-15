#!/usr/bin/env -S deno run -A
/**
 * Regenerates the compile half of
 * `packages/patterns/test/topics-browser-measurement-core.fixture.json`: each
 * named lift's module, the length of its compiled function, the excerpt of the
 * compiled module around its declaration, the identity each Topics module
 * compiles to, and the identity `/topics/main.tsx` compiles to with lines
 * added above the pivot.
 *
 * The browser half is carried over, because no compile produces it: the
 * preview a board's graph snapshot reported for each lift and for
 * `cardsByActivity`, and a preview from a compile with pattern coverage on.
 * Each preview a board reported is checked against the compiled text recorded
 * beside it, so sources that have moved past the recording fail here, naming
 * what to record again, rather than in the unit tests.
 *
 * `instrumentedPreview` is the one field nothing here checks. It stands for
 * what coverage instrumentation emits, and the tests reading it ask only
 * whether it holds a coverage hit call, which a compile with coverage off
 * never writes. A recorded hit call stays one however the Topics sources move,
 * so the field is carried without a check.
 *
 * Run it from anywhere in the checkout:
 *
 *     deno run -A \
 *       packages/patterns/tools/regenerate-topics-measurement-fixture.ts
 */

import { join } from "@std/path";

import {
  compiledLiftText,
  PREVIEW_LENGTH,
} from "../integration/topics-browser-measurement-core.ts";
import {
  type CompiledTopicsModule,
  compileTopicsProgram,
  TOPICS_LIFTS,
} from "../integration/topics-browser-measurement.ts";

/** The fixture this rewrites. */
const FIXTURE = join(
  import.meta.dirname!,
  "..",
  "test",
  "topics-browser-measurement-core.fixture.json",
);

/** The module whose compile with lines added above it the fixture records. */
const SHIFTED_MODULE = "/topics/main.tsx";

/**
 * How many lines that compile adds. The pivot's position in sources shifted by
 * this many lines is where `cardsByActivity` starts in the sources the board
 * runs, which is the collision the unit test reads the identity check against.
 */
const SHIFTED_LINES = 68;

/** The lift whose compiled text the shifted pivot's position lands on. */
const COLLIDING_LIFT = "cardsByActivity";

/** What the fixture holds. */
interface Fixture {
  /** Each named lift's compiled text and the preview the browser reported. */
  lifts: Record<string, {
    module: string;
    length: number;
    preview: string;
    excerpt: string;
  }>;

  /** The preview the browser reported for {@link COLLIDING_LIFT}. */
  cardsByActivityPreview: string;

  /**
   * A preview recorded from a compile with pattern coverage on, carried over
   * unchecked; the module comment says why.
   */
  instrumentedPreview: string;

  /** Content identity of each compiled Topics module, by `/<module>`. */
  identities: Record<string, string>;

  /** What {@link SHIFTED_MODULE} compiles to with the lines added. */
  shiftedMainIdentity: string;
}

/** Returns the module `filename` of a compiled program. */
function moduleOf(
  modules: readonly CompiledTopicsModule[],
  filename: string,
): CompiledTopicsModule {
  const module = modules.find((candidate) => candidate.filename === filename);
  if (module === undefined) {
    throw new Error(`Compiling the Topics program emitted no \`${filename}\``);
  }
  return module;
}

/**
 * Returns the lines of `js` from two lines above `name`'s declaration through
 * the line after the one its compiled function `text` ends on: enough of the
 * compiled module to read one declaration out of, and little enough to read.
 */
function excerptAround(js: string, name: string, text: string): string {
  const at = js.indexOf(text);
  const declared = at === -1 ? -1 : js.lastIndexOf(`const ${name}`, at);
  if (declared === -1) {
    throw new Error(`\`${name}\`'s compiled declaration is not in its module`);
  }
  const from = js.lastIndexOf("\n", js.lastIndexOf("\n", declared - 1) - 1) + 1;
  const statementEnd = js.indexOf("\n", at + text.length);
  const to = statementEnd === -1 ? -1 : js.indexOf("\n", statementEnd + 1);
  return js.slice(from, to === -1 ? js.length : to + 1);
}

/**
 * Returns `preview` after requiring it to be the first {@link PREVIEW_LENGTH}
 * characters of `text`, which is what the measurement compares a running
 * implementation against.
 */
function carryOver(name: string, preview: string, text: string): string {
  if (preview !== text.slice(0, PREVIEW_LENGTH)) {
    throw new Error(
      `The preview recorded for \`${name}\` is no longer the first ` +
        `${PREVIEW_LENGTH} characters of its compiled text, so the browser ` +
        `half of the fixture is older than these sources: record it again ` +
        `from a board seeded from them`,
    );
  }
  return preview;
}

const carried: Fixture = JSON.parse(await Deno.readTextFile(FIXTURE));
const modules = await compileTopicsProgram();

const lifts: Fixture["lifts"] = {};
for (const lift of TOPICS_LIFTS) {
  const module = `/${lift.module}`;
  const text = compiledLiftText(
    moduleOf(modules, module).js,
    lift.name,
    module,
  );
  const recorded = carried.lifts[lift.name];
  if (recorded === undefined) {
    throw new Error(`The fixture records no preview for \`${lift.name}\``);
  }
  lifts[lift.name] = {
    module,
    length: text.length,
    preview: carryOver(lift.name, recorded.preview, text),
    excerpt: excerptAround(
      moduleOf(modules, module).js,
      lift.name,
      text,
    ),
  };
}

const shifted = await compileTopicsProgram({
  rewrite: (name, contents) =>
    name === SHIFTED_MODULE
      ? `${"//\n".repeat(SHIFTED_LINES)}${contents}`
      : contents,
});
const shiftedMainIdentity = moduleOf(shifted, SHIFTED_MODULE).identity;
if (shiftedMainIdentity === moduleOf(modules, SHIFTED_MODULE).identity) {
  throw new Error(
    `Adding ${SHIFTED_LINES} lines above \`${SHIFTED_MODULE}\` left its ` +
      `identity unchanged, so it records nothing the identity check can fail`,
  );
}

const fixture: Fixture = {
  lifts,
  cardsByActivityPreview: carryOver(
    COLLIDING_LIFT,
    carried.cardsByActivityPreview,
    compiledLiftText(
      moduleOf(modules, SHIFTED_MODULE).js,
      COLLIDING_LIFT,
      SHIFTED_MODULE,
    ),
  ),
  instrumentedPreview: carried.instrumentedPreview,
  identities: Object.fromEntries(
    modules.filter((module) => module.filename.startsWith("/topics/"))
      .map((module) => [module.filename, module.identity]),
  ),
  shiftedMainIdentity,
};
await Deno.writeTextFile(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${FIXTURE}`);
