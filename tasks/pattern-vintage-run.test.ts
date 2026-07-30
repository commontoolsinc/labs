import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { collectVintages, PINNED } from "./pattern-vintage-lib.ts";
import {
  captureMissing,
  type GateRoots,
  replayAll,
} from "./pattern-vintage-run.ts";

/**
 * The gate, end to end, against a throwaway pattern.
 *
 * This is the check that was being run BY HAND on every change — capture a
 * vintage, break the pattern on purpose, confirm the gate goes red. A gate
 * nobody has proved can fail is not a gate, and a manual proof is one that
 * stops happening.
 */

const signer = await Identity.fromPassphrase("pattern vintage gate test");
const KEY = "vintage-gate-subject.tsx";

/**
 * A CFC-labelled field is what makes the root store a CFC schema envelope, and
 * the envelope is what the additive-required guard merges against. Without one
 * the guard never runs and the "broken" case below would pass — the gate would
 * look green on exactly the change it exists to stop.
 */
const PRELUDE = [
  "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
  "const ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'VintageGateSubject',",
  "  subject: 'did:example:vintage-gate',",
  "} as const;",
  "type Label = readonly [typeof ATOM];",
];

const HEALTHY = [
  ...PRELUDE,
  "export interface Output {",
  "  owner: Confidential<Writable<string>, Label>;",
  "  items: Writable<string[]>;",
  "}",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const owner = new Writable<string>('v').for('owner');",
  "  const items = new Writable<string[]>([]).for('items');",
  "  return { owner, items };",
  "});",
  "",
].join("\n");

/** The estuary shape: additive, required, no default. */
const BREAKING = [
  ...PRELUDE,
  "export interface Output {",
  "  owner: Confidential<Writable<string>, Label>;",
  "  items: Writable<string[]>;",
  "  addedLater: Writable<string[]>;",
  "}",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const owner = new Writable<string>('v').for('owner');",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const addedLater = new Writable<string[]>([]).for('addedLater');",
  "  return { owner, items, addedLater };",
  "});",
  "",
].join("\n");

/** The fix: identical, but the new field carries a default. */
const COMPATIBLE = BREAKING.replace(
  "  addedLater: Writable<string[]>;",
  "  addedLater: Writable<string[] | Default<[]>>;",
);

/** Same contract, different backing cell — the class the gate cannot see. */
const MOVED_KEY = HEALTHY.replace(".for('items')", ".for('itemList')");

/**
 * The subject's own test, which is what CAPTURE runs.
 *
 * A capture drives the pattern through its tests rather than materializing it
 * bare, so the fixture holds state written through a real handler. This one
 * writes to `items` and asserts the write landed — the assertion matters
 * because a capture refuses a run whose tests did not pass, so a fixture can
 * never record a state the pattern does not actually reach.
 */
const SUBJECT_TEST = [
  "import { action, assert, pattern } from 'commonfabric';",
  `import Subject from './${KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  return {",
  "    tests: [{ action: add }, { assertion: added }],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

const TEST_KEY = KEY.replace(/\.tsx$/, ".test.tsx");

describe("the vintage gate, end to end", () => {
  let dir = "";
  let roots: GateRoots;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "vintage-gate-" });
    await Deno.mkdir(`${dir}/patterns`, { recursive: true });
    roots = {
      repoRoot: dir,
      patternsRoot: `${dir}/patterns`,
      vintagesRoot: `${dir}/vintages`,
      signer,
    };
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, HEALTHY);
    await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, SUBJECT_TEST);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  const setSource = (source: string) =>
    Deno.writeTextFile(`${dir}/patterns/${KEY}`, source);

  it("captures a vintage for a required pattern that has none", async () => {
    const { captured, problems } = await captureMissing(
      roots,
      [KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    expect(problems).toEqual([]);
    expect(captured).toHaveLength(1);
    // Named by the identity that WROTE it, and findable by enumeration.
    const found = await collectVintages(roots.vintagesRoot);
    expect(found).toHaveLength(1);
    expect(found[0].patternKey).toBe(KEY);
    expect(found[0].identity.length).toBeGreaterThan(0);
    expect(Deno.statSync(captured[0]).size).toBeGreaterThan(0);
  });

  it("captures nothing when the required pattern already has a vintage", async () => {
    // `--update` must only ever ADD. A second run that recaptured would let a
    // broken pattern overwrite the very vintage that would have caught it.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
    const { captured } = await captureMissing(
      roots,
      [KEY],
      new Date("2026-07-29T13:00:00.000Z"),
    );

    expect(captured).toEqual([]);
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });

  it("passes when today's source still reads the vintage", async () => {
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toEqual([]);
  });

  it("FAILS when today's source cannot read the vintage", async () => {
    // The whole point. Everything else in this file is scaffolding for it.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
    await setSource(BREAKING);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    expect(failures[0].patternKey).toBe(KEY);
    // Assert the SPECIFIC rejection. A generic "something failed" would also
    // pass if the fixture were missing, the source failed to compile, or the
    // runtime died — none of which is the break this gate exists to catch.
    expect(failures[0].detail).toContain(
      "required field addedLater needs a default to preserve old documents",
    );
  });

  it("passes again once the new field carries a default", async () => {
    // The other half of the red/green pair: the two candidates differ by
    // exactly `Default<[]>`, so the failure above is attributable to that and
    // not to anything else about the change.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
    await setSource(COMPATIBLE);

    const { failures } = await replayAll(roots);

    expect(failures).toEqual([]);
  });

  it("FAILS a fixture that did not restore, rather than reading it clean", async () => {
    // The worst available green. An empty store presents to the runtime as a
    // fresh space; today's source materializes onto a fresh space perfectly
    // well; the root then reads as something. Every check the replay makes
    // passes, the pattern counts as covered, and NOTHING was replayed.
    //
    // Measured that it is the real behaviour and not a worry: with the
    // identity control removed, this case goes green while the rest of the
    // file stays green too — no other assertion here can see it.
    const dir = `${roots.vintagesRoot}/${KEY}/${PINNED}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(
      `${dir}/2026-07-29T12-00-00.000Z-neverwritten.sqlite`,
      new Uint8Array(),
    );

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("did not restore");
  });

  it("does NOT catch a moved storage key — the gap, pinned", async () => {
    // Asserting a LIMIT, deliberately. `.for('items')` → `.for('itemList')`
    // leaves the declared contract byte-identical and strands every document
    // written under the old name — the class Tier 2 was built for, and the one
    // this gate's own header and CI comment must not be read as claiming.
    //
    // Two reasons it replays clean, both structural rather than incidental:
    // `captureVintage` snapshots a root that was just set up, so there is no
    // prior data to strand; and `replayVintage` asks only whether the
    // materialize was refused, never whether the values survived. Closing
    // either would close this.
    //
    // `packages/piece/test/state-continuity.test.ts` covers the class itself,
    // over a POPULATED vintage. When the gate grows a value comparison this
    // test should be INVERTED, not deleted.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
    await setSource(MOVED_KEY);

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toEqual([]);
  });

  it("reports a vintage whose pattern no longer exists", async () => {
    // Deleting a pattern is legitimate — retiring it — but it must be visible
    // rather than silently reducing coverage to nothing.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
    await Deno.remove(`${dir}/patterns/${KEY}`);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    // Names WHICH pattern stopped resolving, not just that something did — a
    // fixture records many instantiations, so an unattributed failure would
    // leave the reader to guess which of them retired.
    expect(failures[0].detail).toContain(`/patterns/${KEY} no longer resolves`);
  });
});
