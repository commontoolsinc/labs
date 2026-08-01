import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { AUTO, collectVintages, PINNED } from "./pattern-vintage-lib.ts";
import {
  openFileBackedRuntime,
  readVintageManifest,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";
import {
  captureMissing,
  captureVintage,
  type GateRoots,
  isUpgradeTarget,
  replayAll,
  snippet,
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
  "import { Confidential, Default, Stream, Writable, handler, pattern } from 'commonfabric';",
  "const ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'VintageGateSubject',",
  "  subject: 'did:example:vintage-gate',",
  "} as const;",
  "type Label = readonly [typeof ATOM];",
  // A STREAM in the output, because every real pattern has several and a root
  // holding one is not plain data: the read yields a live cell whose own
  // properties reach the whole runtime. A subject made only of data cells
  // cannot exercise that, and a comparison that mishandles it would look
  // perfectly green here while reporting six false findings on `home.tsx`.
  "const touch = handler<Record<string, never>, { items: Writable<string[]> }>(",
  "  (_event, { items }) => { items.push('touched'); },",
  ");",
];

const HEALTHY = [
  ...PRELUDE,
  "export interface Output {",
  "  owner: Confidential<Writable<string>, Label>;",
  "  items: Writable<string[]>;",
  "  touch: Stream<Record<string, never>>;",
  "}",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const owner = new Writable<string>('v').for('owner');",
  "  const items = new Writable<string[]>([]).for('items');",
  "  return { owner, items, touch: touch({ items }) };",
  "});",
  "",
].join("\n");

/** The estuary shape: additive, required, no default. */
const BREAKING = [
  ...PRELUDE,
  "export interface Output {",
  "  owner: Confidential<Writable<string>, Label>;",
  "  items: Writable<string[]>;",
  "  touch: Stream<Record<string, never>>;",
  "  addedLater: Writable<string[]>;",
  "}",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const owner = new Writable<string>('v').for('owner');",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const addedLater = new Writable<string[]>([]).for('addedLater');",
  "  return { owner, items, touch: touch({ items }), addedLater };",
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
 * A subject whose module contributes MORE than one instantiable pattern: its
 * default export, a named `Row`, and the transformer hoist (`__cfPattern_N`)
 * that `map` lowers its callback into. All three get stored roots, so a replay
 * has to apply the artifact each root actually names.
 *
 * `rows` is read by the companion test on purpose — an unread `map` never runs,
 * so the nested patterns would never instantiate and the fixture would record
 * only the default export.
 */
const NESTED_KEY = "vintage-gate-nested.tsx";
const NESTED_TEST_KEY = NESTED_KEY.replace(/\.tsx$/, ".test.tsx");

const nestedSource = (extra: { field?: string; line?: string } = {}) =>
  [
    "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateNested',",
    "  subject: 'did:example:vintage-gate-nested',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    "interface RowOut { shout: string }",
    "export const Row = pattern<{ word: string }, RowOut>(({ word }) => {",
    "  return { shout: word };",
    "});",
    "export interface Output {",
    "  owner: Confidential<Writable<string>, Label>;",
    "  items: Writable<string[]>;",
    "  rows: RowOut[];",
    ...(extra.field ? [extra.field] : []),
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const items = new Writable<string[]>([]).for('items');",
    "  const rows = items.map((word) => Row({ word }));",
    ...(extra.line ? [extra.line] : []),
    `  return { owner, items, rows${extra.line ? ", later" : ""} };`,
    "});",
    "",
  ].join("\n");

const NESTED = nestedSource();

/**
 * Same contract plus a defaulted field — compatible, but a DIFFERENT module
 * identity, which is what makes the replay actually materialize instead of
 * short-circuiting on an unchanged identity.
 */
const NESTED_CHANGED = nestedSource({
  field: "  later: Writable<string[] | Default<[]>>;",
  line: "  const later = new Writable<string[]>([]).for('later');",
});

/** The named sub-pattern is gone: a stored root names an artifact that is not there. */
const NESTED_ROW_RENAMED = NESTED_CHANGED
  .replace("export const Row =", "export const Renamed =")
  .replace("Row({ word })", "Renamed({ word })");

/**
 * The same artifact under TWO export names, and the same module with those two
 * statements swapped. Only enumeration order differs, so the CANONICAL symbol
 * flips while the artifact, the schemas and the state are all identical.
 */
const aliased = (aliasFirst: boolean) =>
  nestedSource({
    field: "  later: Writable<string[] | Default<[]>>;",
    line: "  const later = new Writable<string[]>([]).for('later');",
  })
    .replace("export const Row =", "const Row =")
    .replace(
      "});\nexport interface Output {",
      `});\n${
        aliasFirst
          ? "export { Row as RowAlias };\nexport { Row };"
          : "export { Row };\nexport { Row as RowAlias };"
      }\nexport interface Output {`,
    );

const NESTED_ALIASED = aliased(false);
const NESTED_ALIASED_FLIPPED = aliased(true);

/**
 * A subject that returns a key its declared output type never NAMES, riding an
 * index signature instead — the shape `system/default-app.tsx` declares
 * (`[key: string]: unknown`), and the reason its root's `recentPieces`,
 * `summaryIndex` and `trackRecent` are stored under
 * `additionalProperties: {"type": "unknown"}`.
 *
 * A schema-driven read resolves nothing at an `unknown` position, so such a key
 * came back `undefined` however much state it held — indistinguishable from a
 * key the document does not hold, which the comparison treats as nothing to
 * lose. Measured on the committed `default-app.tsx` fixture: DROPPING
 * `trackRecent` from the returned result replayed "3 updated cleanly with no
 * state stranded".
 *
 * `notes` is written through a HANDLER rather than seeded, for the reason the
 * cross-space child is: today's source seeds the fresh cell under the new name
 * with the same literal, so a subject holding only what its source seeds cannot
 * witness a moved storage key.
 */
const UNDECLARED_KEY = "vintage-gate-undeclared.tsx";
const UNDECLARED_TEST_KEY = UNDECLARED_KEY.replace(/\.tsx$/, ".test.tsx");

const undeclaredSource = (storageKey: string, trailer = "") =>
  [
    "import { Confidential, Stream, Writable, handler, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateUndeclared',",
    "  subject: 'did:example:vintage-gate-undeclared',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    "const scribble = handler<{ text: string }, { notes: Writable<string[]> }>(",
    "  ({ text }, { notes }) => { notes.push(text); },",
    ");",
    "export interface Output {",
    "  [key: string]: unknown;",
    "  owner: Confidential<Writable<string>, Label>;",
    "  items: Writable<string[]>;",
    "  scribble: Stream<{ text: string }>;",
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const items = new Writable<string[]>([]).for('items');",
    `  const notes = new Writable<string[]>([]).for('${storageKey}');`,
    "  return { owner, items, scribble: scribble({ notes }), notes };",
    "});",
    trailer,
    "",
  ].join("\n");

/**
 * The subject's own test. `items` carries the assertion because a capture
 * refuses a run with none; `scribble` is what puts a value in the UNDECLARED
 * key, which is the one the cases below are about.
 */
const undeclaredTest = [
  "import { action, assert, pattern } from 'commonfabric';",
  `import Subject from './${UNDECLARED_KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  const write = action(() => {",
  "    subject.scribble.send({ text: 'noted' });",
  "  });",
  "  return {",
  "    tests: [{ action: add }, { assertion: added }, { action: write }],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

/**
 * A subject whose child is instantiated in ANOTHER space — the shape
 * `system/profile-create.tsx` uses, where each profile lives in its own
 * `ProfileHome.inSpace()` space.
 *
 * The child owns its own CFC-labelled root in that space, so the fixture has to
 * CARRY that space and the replay has to READ the child's root out of it. Get
 * either wrong and the read finds a fresh empty space, today's source
 * materializes onto it, and the entry counts as updated cleanly.
 *
 * `added` is the type of a field appended to the CHILD's output: `string[]` is
 * the estuary shape (additive, required, no default) and
 * `string[] | Default<[]>` is the same edit made compatible. The parent's
 * contract is identical either way, so any difference between the two runs is
 * attributable to the child's root — the one in the other space.
 */
const CROSS_KEY = "vintage-gate-crossspace.tsx";
const CROSS_TEST_KEY = CROSS_KEY.replace(/\.tsx$/, ".test.tsx");

/**
 * The child's space. NAMED rather than anonymous (`inSpace()` derives a DID
 * from the creating frame's cause), so a case can state which DID it expects.
 */
const CHILD_SPACE = (await Identity.fromPassphrase("vintage gate child space"))
  .did();

const crossSource = (added?: string) =>
  [
    "import { Confidential, Default, Stream, Writable, handler, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateCross',",
    "  subject: 'did:example:vintage-gate-cross',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    // The child's own handler, so the capture can write INTO the other space
    // the way production does. A `.set()` from the parent's space does not
    // land — measured, the child still reads its seeded value afterwards — and
    // a child holding only what its source seeds cannot witness a moved
    // storage key: the fresh cell under the new name seeds the same string.
    "const scribble = handler<{ text: string }, { note: Writable<string> }>(",
    "  ({ text }, { note }) => { note.set(text); },",
    ");",
    "export interface ChildOut {",
    "  owner: Confidential<Writable<string>, Label>;",
    "  note: Writable<string>;",
    "  scribble: Stream<{ text: string }>;",
    ...(added ? [`  addedLater: Writable<${added}>;`] : []),
    "}",
    "export const Child = pattern<Record<string, never>, ChildOut>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const note = new Writable<string>('captured').for('note');",
    ...(added
      ? ["  const addedLater = new Writable<string[]>([]).for('addedLater');"]
      : []),
    `  return { owner, note, scribble: scribble({ note })${
      added ? ", addedLater" : ""
    } };`,
    "});",
    "export interface Output {",
    "  items: Writable<string[]>;",
    "  child: ChildOut;",
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const items = new Writable<string[]>([]).for('items');",
    `  const child = Child.inSpace('${CHILD_SPACE}')({});`,
    "  return { items, child };",
    "});",
    "",
  ].join("\n");

/**
 * Reads the child's `note` on purpose. The assertion is what proves the
 * cross-space child really materialized during the capture — without it a
 * fixture recording the child would be indistinguishable from one that recorded
 * a root nothing ever wrote.
 *
 * It then drives the child's OWN handler, so the fixture holds a value in the
 * other space that today's source cannot reproduce from its defaults — which is
 * what lets a case there tell a moved storage key from an intact one.
 */
const crossTest = [
  "import { action, assert, pattern } from 'commonfabric';",
  `import Subject from './${CROSS_KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  const noted = assert(() => subject.child.note.get() === 'captured');",
  "  const scribble = action(() => {",
  "    subject.child.scribble.send({ text: 'written' });",
  "  });",
  "  const wrote = assert(() => subject.child.note.get() === 'written');",
  "  return {",
  "    tests: [",
  "      { action: add },",
  "      { assertion: added },",
  "      { assertion: noted },",
  "      { action: scribble },",
  "      { assertion: wrote },",
  "    ],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

const nestedTest = (key: string) =>
  [
    "import { action, assert, pattern } from 'commonfabric';",
    `import Subject from './${key}';`,
    "export default pattern(() => {",
    "  const subject = Subject({});",
    "  const add = action(() => {",
    "    subject.items.set([...subject.items.get(), 'captured']);",
    "  });",
    "  const added = assert(() => subject.items.get().length === 1);",
    // Reads `rows`, which is what makes the map run and the nested patterns
    // instantiate. Without this the fixture records only the default export.
    "  const mapped = assert(() =>",
    "    subject.rows.length === 1 && subject.rows[0].shout === 'captured'",
    "  );",
    "  return {",
    "    tests: [{ action: add }, { assertion: added }, { assertion: mapped }],",
    "    subject,",
    "  };",
    "});",
    "",
  ].join("\n");

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

/**
 * The upgrade-target filter, case by case.
 *
 * Its own tests rather than only end-to-end coverage, because the invariant it
 * carries is one prose already failed to enforce: a test pattern creates stores
 * and is NEVER an upgrade target. Applying today's test pattern at a store's top
 * measurably makes the gate WEAKER — the additive-required break exits 0 —
 * so this is the mechanical guard that keeps it from being merely written down.
 */
describe("isUpgradeTarget", () => {
  const entry = (
    over: Partial<Parameters<typeof isUpgradeTarget>[0]> = {},
  ) => ({
    identity: "abc123",
    symbol: "default",
    main: "/packages/patterns/system/home.tsx",
    cellId: "of:fid1:whatever",
    space: "did:key:zSpace",
    ...over,
  });

  it("accepts an authored pattern file", () => {
    expect(isUpgradeTarget(entry())).toBe(true);
  });

  it("REFUSES a test pattern — it creates stores, it is never a target", () => {
    expect(isUpgradeTarget(entry({ main: "/p/home.test.tsx" }))).toBe(false);
    expect(isUpgradeTarget(entry({ main: "/p/home.test.ts" }))).toBe(false);
  });

  it("refuses an entry with no source path", () => {
    expect(isUpgradeTarget(entry({ main: undefined }))).toBe(false);
  });

  it("refuses a path that is not repo-root-relative", () => {
    // The evaluate loop records injected helper modules too, and they carry no
    // leading slash — `${repoRoot}cfc.ts` would be a separator-less path.
    expect(isUpgradeTarget(entry({ main: "cfc.ts" }))).toBe(false);
  });

  it("refuses a keyless session pointer", () => {
    // Not a content hash, so it can never equal a freshly compiled identity —
    // it would report as CHANGED on every run forever.
    expect(isUpgradeTarget(entry({ identity: "keyless:fid1:XWh0" }))).toBe(
      false,
    );
  });
});

/** The identity a fixture's manifest recorded for its `Child` instantiation. */
async function childRecordedIdentity(fixturePath: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "child-identity-" });
  const vintage = await openFileBackedRuntime(signer, dir, fixturePath);
  try {
    const manifest = await readVintageManifest(vintage);
    const child = manifest?.entries.find((e) => e.symbol === "Child");
    if (child === undefined) throw new Error("no Child instantiation recorded");
    return child.identity;
  } finally {
    await vintage.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

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
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    expect(problems).toEqual([]);
    expect(captured).toHaveLength(1);
    // Named by the identity that WROTE it, and findable by enumeration.
    const found = await collectVintages(roots.vintagesRoot);
    expect(found).toHaveLength(1);
    expect(found[0].testKey).toBe(TEST_KEY);
    expect(found[0].identity.length).toBeGreaterThan(0);
    expect(Deno.statSync(captured[0]).size).toBeGreaterThan(0);
  });

  it("captures nothing when the required pattern already has a vintage", async () => {
    // `--update` must only ever ADD. A second run that recaptured would let a
    // broken pattern overwrite the very vintage that would have caught it.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const { captured } = await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T13:00:00.000Z"),
    );

    expect(captured).toEqual([]);
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });

  it("passes when today's source still reads the vintage", async () => {
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toEqual([]);
  });

  it("FAILS when today's source cannot read the vintage", async () => {
    // The whole point. Everything else in this file is scaffolding for it.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(BREAKING);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    expect(failures[0].testKey).toBe(TEST_KEY);
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
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
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

  it("CATCHES a moved storage key — the class this tier exists for", async () => {
    // The inversion this test was written to receive. `.for('items')` →
    // `.for('itemList')` leaves the declared contract byte-identical and
    // strands every document written under the old name. No contract check can
    // see it, and the materialize succeeds — so until the gate compared VALUES
    // it replayed clean, and this case asserted that limit on purpose.
    //
    // The fixture holds real stranded data because capture drives the pattern
    // through its own tests: `items` was written through a handler before the
    // key moved. That is what makes this a test of the CHECK rather than of the
    // fixture.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(MOVED_KEY);

    const { replayed, stranded, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toHaveLength(1);
    // The specific finding, not merely "something failed": the update APPLIED
    // and the loss is what the gate caught. A generic assertion here would also
    // pass on a refusal, a compile error, or a fixture that never restored —
    // none of which is this class.
    expect(failures[0].detail).toContain("APPLIED CLEANLY but stranded");
    expect(failures[0].detail).toContain("items");
    // EXACTLY one key, which the failure count cannot say: every stranded key
    // on one root lands in a single failure, so a comparison that also reported
    // the subject's stream — the false finding this suite now carries a stream
    // to catch — would still leave `failures` at one.
    expect(stranded).toBe(1);
  });

  it("reports a vintage whose pattern no longer exists", async () => {
    // Deleting a pattern is legitimate — retiring it — but it must be visible
    // rather than silently reducing coverage to nothing.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await Deno.remove(`${dir}/patterns/${KEY}`);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    // Names WHICH pattern stopped resolving, not just that something did — a
    // fixture records many instantiations, so an unattributed failure would
    // leave the reader to guess which of them retired.
    expect(failures[0].detail).toContain(`/patterns/${KEY} no longer resolves`);
  });

  it("FAILS a fixture holding a root it cannot map to a file", async () => {
    // Narrowed coverage must not read as success. The replay SKIPS an entry with
    // no source path, so a green verdict would be a claim about fewer roots than
    // the fixture holds — the shape this tier has mistaken for a pass three
    // times. Capture refuses to create one of these, so it is written directly.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-doctor-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const manifest = await readVintageManifest(vintage);
      await writeVintageManifest(vintage, [
        ...(manifest?.entries ?? []),
        {
          identity: pinned.identity,
          symbol: "__cfPattern_9",
          cellId: "of:fid1:unmappable",
          space: signer.did(),
        },
        {
          identity: pinned.identity,
          symbol: "__cfPattern_10",
          // An injected helper module's name: present, but not a repo path.
          main: "cfc.ts",
          cellId: "of:fid1:notrootrelative",
          space: signer.did(),
        },
        {
          // Repo-root-relative and a real-looking path, but NOT under
          // `packages/patterns/` and not a served route — so there is no
          // pattern key for it. Capture refuses this shape now (it asks
          // `patternKeyFromMain`, the same question replay asks), which is why
          // it has to be written directly.
          //
          // It reuses a REAL recorded root rather than a synthetic cell id, on
          // purpose: the presence control runs before key resolution, so an id
          // nothing wrote is reported as a root the fixture does not hold and
          // never reaches the branch this case is about.
          ...(manifest?.entries ?? []).find((e) => e.main !== undefined)!,
          symbol: "__cfPattern_11",
          main: "/packages/home-schemas/well-known.tsx",
        },
      ]);
      // To a fresh path, not over the file this runtime opened FROM — sqlite
      // refuses that — then swapped in once the handles are closed.
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    // The PRIMARY file only, which is enough here because this fixture is
    // single-space. Do not copy this idiom onto a multi-space one: `snapshot`
    // writes a companion directory too, and moving the primary alone would
    // silently leave the other spaces behind.
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { unmappable, failures } = await replayAll(roots);

    // Both shapes count: no source path at all, and a path that is not
    // repo-root-relative (the evaluate loop records injected helper modules
    // like `cfc.ts`, whose names carry no leading slash).
    expect(unmappable).toBe(2);
    // Three failures for two `unmappable`: the third entry IS repo-root-
    // relative, so it passes the capture-side shape check and is only refused
    // where the key is resolved. Both are reported; only the first two are
    // that counter's business.
    expect(failures).toHaveLength(3);
    // Each reason bound to ITS entry. Asserting both strings against the joined
    // text would pass just as well with the two reasons swapped, which is the
    // mistake that reports the wrong diagnosis for the right count.
    const reasonFor = (symbol: string) =>
      failures.find((f) => f.detail.includes(symbol))?.detail;
    expect(reasonFor("__cfPattern_9")).toContain("no source path");
    expect(reasonFor("__cfPattern_10")).toContain(
      '"cfc.ts" is not repo-root-relative',
    );
    expect(reasonFor("__cfPattern_11")).toContain(
      "neither a repo path nor a served pattern route",
    );
  });

  it("FAILS a fixture that records NO instantiations", async () => {
    // An empty manifest means there is nothing to apply today's source to, so
    // a green run would be a statement about zero roots. The gate has mistaken
    // that shape for a pass before, which is why it is a failure rather than a
    // note.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-empty-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      await writeVintageManifest(vintage, []);
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { failures, candidates } = await replayAll(roots);

    expect(candidates).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("records no pattern instantiations");
    // The remedy is part of the message: `--update` alone prints "already
    // pinned" and changes nothing, so a reader told only "this is broken"
    // cannot act.
    expect(failures[0].detail).toContain("Delete");
  });

  it("FAILS a fixture holding state its NAME does not claim", async () => {
    // The filename records which pattern version wrote the state. A fixture
    // whose manifest holds only other identities is not the state its name
    // claims — provenance and content disagreeing, which makes every later
    // judgement about it meaningless.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-identity-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, identity: "someoneelse" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("does not contain");
    // Both sides named, so the reader can see WHICH disagreed rather than
    // being told only that something did.
    expect(failures[0].detail).toContain(pinned.identity);
    expect(failures[0].detail).toContain("someoneelse");
  });

  it("FAILS a fixture whose pattern no longer COMPILES", async () => {
    // Distinct from "no longer resolves": the file is still there and still
    // readable, and the compiler rejects it. Reported per entry rather than
    // thrown, so one broken pattern does not take every remaining fixture with
    // it — the whole reason the replay reports instead of raising.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    // Valid TypeScript the pattern compiler cannot accept: no default export,
    // so there is no artifact for the recorded root to name.
    await Deno.writeTextFile(
      `${roots.patternsRoot}/${KEY}`,
      "export const notAPattern = 1;\n",
    );

    const { failures } = await replayAll(roots);

    expect(failures.length).toBeGreaterThan(0);
    // The SPECIFIC diagnosis. A bare "there was a failure" would pass on a
    // missing store or a disposed runtime just as well.
    expect(failures.map((f) => f.detail).join("\n")).toMatch(
      /no longer (compiles|resolves)/,
    );
  });

  it("still MATERIALIZES a served-route target, only skipping its identity", async () => {
    // A pattern loaded BY URL records the route the toolshed serves it at, and
    // the same file compiles to a different identity served than from the repo
    // — so an identity comparison would call it changed on every run forever.
    // That is the whole of what a served route may skip. Skipping the TARGET
    // outright meant a recorded root got no materialize and no state
    // comparison at all, and the committed lunch-poll fixture holds exactly
    // this shape for `profile-create`: a breaking change to it left the run
    // green.
    //
    // Proved by BREAKING the source the route maps to. Counting served routes
    // would pass this case just as well if they were still skipped, so the
    // assertion is on the failure the comparison produces.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-served-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    let subjectCell: string | undefined;
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // The entry that actually holds the subject's state, re-pointed at the
      // ROUTE the same file would be served under. Same cell, same identity —
      // only `main` changes, so anything that still fails is the served-route
      // path and not a different fixture.
      const subject = entries.find((entry) => entry.main?.endsWith(`/${KEY}`))!;
      subjectCell = subject.cellId;
      await writeVintageManifest(vintage, [
        ...entries.filter((entry) => entry !== subject),
        { ...subject, main: `/api/patterns/${KEY}` },
      ]);
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    expect(subjectCell, "the fixture no longer records the subject")
      .toBeDefined();

    // Green first: the route resolves to today's unchanged source, and a
    // served route is materialized every run because it has no "changed"
    // answer. Without this control the red below could be a route that never
    // resolved at all.
    const clean = await replayAll(roots);
    expect(clean.failures, "an UNBROKEN served route should replay clean")
      .toEqual([]);
    expect(clean.servedRoute).toBe(1);
    // ...and it is kept out of `changed`, which would otherwise report the
    // same fixed number forever and stop meaning "something moved".
    expect(clean.changed).toBe(0);

    // Now break where the state is STORED, leaving the contract untouched —
    // the class this tier exists for, and one only a materialize can see.
    await Deno.writeTextFile(`${roots.patternsRoot}/${KEY}`, MOVED_KEY);
    const broken = await replayAll(roots);

    expect(
      broken.failures.map((f) => f.detail).join("\n"),
      "a served-route target was not materialized, so a moved storage key in " +
        "it replayed clean — the hole this case exists to close",
    ).toContain("stranded state the vintage held");
  });

  it("attributes a RECORDED pattern the run did not credit", async () => {
    // The provenance an uncovered-pattern failure prints. It has to come from
    // what a fixture RECORDS, not from what the run CREDITS: `uncovered` is
    // exactly the required keys absent from the credited set, so a map built
    // from that set can never name one of them and the "covered by" branch is
    // unreachable by construction. An earlier version made precisely that
    // mistake, and its unit test passed only by hand-building a pair the gate
    // cannot produce.
    //
    // Driven here through the real path, using the auto tier as the reason for
    // withholding credit — it is the one exclusion a test can arrange without
    // corrupting the fixture.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const autoDir = `${roots.vintagesRoot}/${pinnedRef.testKey}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    await Deno.copyFile(
      pinnedRef.path,
      `${autoDir}/${pinnedRef.stamp}-${pinnedRef.identity}.sqlite`,
    );
    await Deno.remove(pinnedRef.path);

    const { covered, coveredBy, targets, failures } = await replayAll(roots);

    // The control that actually controls: the fixture got PAST the presence
    // check and the target filter and produced no failure, so "not credited"
    // is a decision rather than the uninteresting case of nothing having run.
    // (`replayed` would not do — it counts fixtures COLLECTED, before any of
    // those.)
    expect(targets).toBeGreaterThan(0);
    expect(failures, "the auto fixture failed for an unrelated reason")
      .toEqual([]);
    expect([...covered], "an auto fixture credited coverage").toEqual([]);
    // ...and the pattern is still attributed to the test that records it,
    // with the tier that decides the remedy — a reader is told to PIN it, not
    // to read failures that do not exist or capture a fixture that does.
    expect(coveredBy.get(KEY)).toEqual({
      testKey: pinnedRef.testKey,
      pinned: false,
    });
  });

  it("attributes a pattern whose fixture no longer holds its root", async () => {
    // The case the attribution most needs to explain, and the one an earlier
    // ordering missed: `recorded` was populated AFTER the presence-control
    // skip, so a fixture that no longer holds a recorded root reported as
    // though NO fixture recorded the pattern — sending a reader to capture one
    // that is sitting right there, which is the dead end this whole change
    // exists to close.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-lostroot-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinnedRef.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // Same pattern, a root the fixture does not hold: the presence control
      // reports it and the target is skipped before anything is applied.
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, cellId: "of:fid1:nosuchroot" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinnedRef.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { covered, coveredBy, failures } = await replayAll(roots);

    // It failed the presence control, so it is genuinely uncredited...
    expect(failures.length).toBeGreaterThan(0);
    expect([...covered]).toEqual([]);
    // ...and still attributed, from a PINNED fixture — so the remedy is "read
    // the failures", not "capture one".
    expect(coveredBy.get(KEY)).toEqual({
      testKey: pinnedRef.testKey,
      pinned: true,
    });
  });

  it("credits coverage only for a PINNED fixture", async () => {
    // An auto capture is regenerable and pruned by COUNT, so letting one
    // satisfy the coverage gate means retention can delete the gate's only
    // evidence for a pattern while the run still reads green. That guarantee
    // used to live in `coveredPatternKeys`; coverage stopped going through it
    // when it moved to what the replay actually replayed, and the condition
    // that restored it survived deletion with every suite green — which is why
    // this exists.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const covers = pinnedRef.testKey;

    // The control: as PINNED, this fixture credits the pattern it replayed.
    const asPinned = await replayAll(roots);
    expect([...asPinned.covered], "the pinned fixture covered nothing")
      .toContain(KEY);

    // The same bytes under `auto/` credit NOTHING, though they still replay.
    const autoDir = `${roots.vintagesRoot}/${covers}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    await Deno.copyFile(
      pinnedRef.path,
      `${autoDir}/${pinnedRef.stamp}-${pinnedRef.identity}.sqlite`,
    );
    await Deno.remove(pinnedRef.path);

    const asAuto = await replayAll(roots);
    // It was REPLAYED — otherwise "covers nothing" would be true for the
    // uninteresting reason that nothing ran.
    expect(asAuto.replayed, "the auto fixture was not replayed at all").toBe(1);
    expect(asAuto.targets).toBe(asPinned.targets);
    expect([...asAuto.covered], "an AUTO fixture credited coverage").toEqual(
      [],
    );
  });

  it("FAILS a fixture with candidates but no upgrade TARGET, on its own", async () => {
    // Per fixture, not just in the run's total. `isClean` floors the SUM of
    // targets, which a fixture covering nothing slips under the moment another
    // fixture covers five — and this one would have applied today's source to
    // nothing while the run read green. Measured: with the per-fixture check
    // removed, a two-fixture run where the second records only test patterns
    // reports `targets: 1, failures: []` and passes.
    //
    // Reachable rather than theoretical: `isUpgradeTarget` has grown four
    // exclusions, two added after fixtures already existed, and fixtures are
    // append-only. A new exclusion silently zeroes an old fixture's coverage.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-notarget-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // Same roots, re-recorded as test patterns — the shape a later exclusion
      // would produce over a fixture nobody can recapture.
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, main: "/patterns/x.test.tsx" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { targets, failures } = await replayAll(roots);

    expect(targets).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain(
      "not one is something today's source can be applied to",
    );
    // The reason is counted, not asserted: these entries are test patterns, so
    // the message must not blame the other exclusion.
    expect(failures[0].detail).toContain("0 cannot be mapped to a file");
    // And the remedy has to be one that WORKS. `--update` alone would print
    // "already pinned" and change nothing, so the fixture must be named for
    // deletion first — companion directory included.
    expect(failures[0].detail).toContain("deliberately, then");
    expect(failures[0].detail).toContain(".sqlite.spaces/");
  });

  describe("capture refuses a state the pattern never legitimately reaches", () => {
    const setSubjectTest = (body: string) =>
      Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, body);

    it("refuses when the pattern's own tests do not pass", async () => {
      // A fixture is only worth pinning if the state in it is state the pattern
      // actually reaches. Capturing off a failing run would pin a lie, and every
      // later generation would be replayed against it.
      await setSubjectTest(
        [
          "import { assert, pattern } from 'commonfabric';",
          `import Subject from './${KEY}';`,
          "export default pattern(() => {",
          "  const subject = Subject({});",
          "  const never = assert(() => subject.items.get().length === 99);",
          "  return { tests: [{ assertion: never }], subject };",
          "});",
          "",
        ].join("\n"),
      );

      const { captured, problems } = await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );

      expect(captured).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("its own tests did not pass");
      // Nothing was written: a refused capture must not leave a partial fixture
      // behind for a later run to mistake for a good one.
      expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
    });

    it("refuses a test that asserts nothing", async () => {
      // A run with no assertions cannot have driven the pattern anywhere, so the
      // fixture would hold a bare materialized root — which is the shape that
      // makes a green replay meaningless.
      await setSubjectTest(
        [
          "import { pattern } from 'commonfabric';",
          `import Subject from './${KEY}';`,
          "export default pattern(() => {",
          "  const subject = Subject({});",
          "  return { tests: [], subject };",
          "});",
          "",
        ].join("\n"),
      );

      const { captured, problems } = await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );

      expect(captured).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("ran no assertions");
    });
  });

  describe("a module contributing several instantiable patterns", () => {
    const writeNested = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${NESTED_KEY}`, source);

    beforeEach(async () => {
      await writeNested(NESTED);
      await Deno.writeTextFile(
        `${dir}/patterns/${NESTED_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        nestedTest(NESTED_KEY),
      );
    });

    it("records the nested roots under their own symbols", async () => {
      const { problems, captured } = await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      expect(problems).toEqual([]);
      expect(captured).toHaveLength(1);
    });

    it("applies each root's OWN artifact, not the module's entry export", async () => {
      // The default export, `Row`, and the `map` hoist all have stored roots in
      // this fixture. A replay that ignored the recorded symbol would apply the
      // ROOT pattern to the nested cells — a different artifact than the one
      // stored there, which either refuses a valid migration or accepts an
      // invalid one having checked the wrong thing. The edit is
      // schema-compatible, so a symbol-correct replay has nothing to report.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_CHANGED);

      const { changed, failures } = await replayAll(roots);

      // The identity really moved, so the materialize path actually ran — this
      // test would be vacuous if the replay had short-circuited.
      expect(changed).toBeGreaterThan(1);
      expect(failures).toEqual([]);
    });

    it("a cosmetic export reorder is not a failed migration", async () => {
      // One artifact exported under TWO names has a single CANONICAL symbol,
      // and `setArtifactEntryRef` is first-write-wins — so which name is
      // canonical depends on export enumeration order. The completion marker the
      // runner stamps carries the canonical symbol, not the one the fixture
      // recorded, so comparing against the recorded name reported a clean swap
      // as "setup did not complete … the root carries …#RowAlias". Reordering
      // two export statements must not read as a broken migration.
      await writeNested(NESTED_ALIASED);
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ALIASED_FLIPPED);

      const { changed, failures } = await replayAll(roots);

      // More than one, so a NESTED root was among them — the aliased artifact is
      // one of those. `> 0` would stay green if a future change stopped
      // materializing the nested roots and only the entry pattern was applied,
      // which is the coverage this case exists to have.
      expect(changed).toBeGreaterThan(1);
      expect(failures).toEqual([]);
    });

    it("FAILS CLOSED when a stored root names an artifact this version dropped", async () => {
      // Renaming the exported sub-pattern leaves a root naming a symbol today's
      // module does not define. Falling back to the entry export would quietly
      // validate the wrong artifact; the honest answer is a reported finding.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ROW_RENAMED);

      const { failures } = await replayAll(roots);

      expect(failures.length).toBeGreaterThan(0);
      expect(
        failures.some((f) => f.detail.includes('defines no "Row"')),
      ).toBe(true);
    });
  });

  describe("a key the declared output type never names", () => {
    const STAMP = new Date("2026-07-29T12:00:00.000Z");

    const writeUndeclared = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${UNDECLARED_KEY}`, source);

    beforeEach(async () => {
      await writeUndeclared(undeclaredSource("notes"));
      await Deno.writeTextFile(
        `${dir}/patterns/${UNDECLARED_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        undeclaredTest,
      );
    });

    it("CATCHES a moved storage key at an `unknown` position", async () => {
      // The blind spot, closed. `notes` rides the index signature, so the root
      // stores it under `additionalProperties: {"type": "unknown"}` and a
      // schema-driven read resolves NOTHING there — the before value came back
      // `undefined`, `isPreserved` read that as "held nothing", and the moved
      // key replayed clean. Red/green on the real tree, not just here: dropping
      // `trackRecent` from `system/default-app.tsx`'s result reported "3
      // updated cleanly with no state stranded" against the committed fixture,
      // and names the key once the read is relaxed.
      await captureMissing(roots, [UNDECLARED_TEST_KEY], STAMP);
      await writeUndeclared(undeclaredSource("notesMoved"));

      const { failures } = await replayAll(roots);

      expect(failures).toHaveLength(1);
      // The SPECIFIC finding, with both values. A generic assertion would also
      // pass on a refusal or an unreadable root, and the before value is what
      // proves the handler's write was actually captured — a subject that only
      // ever seeded `notes` would show `[]` on both sides and report nothing.
      expect(failures[0].detail).toContain("APPLIED CLEANLY but stranded");
      expect(failures[0].detail).toContain('notes (was ["noted"], now [])');
    });

    it("reports nothing when the key did not move", async () => {
      // The green half, and the false-positive guard the relaxation needs: it
      // makes the comparison SEE keys it could not before, so it also gets to
      // manufacture findings about them. The two sources differ by a trailing
      // comment — same storage, different identity, so the replay actually
      // materializes instead of short-circuiting on an unchanged identity.
      await captureMissing(roots, [UNDECLARED_TEST_KEY], STAMP);
      await writeUndeclared(undeclaredSource("notes", "// touched"));

      const { changed, failures } = await replayAll(roots);

      expect(changed).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    });
  });

  describe("a child instantiated in ANOTHER space", () => {
    // One stamp for the whole block, so a case that captures twice lands on the
    // SAME fixture path — which is how the overwrite and partial-write cases
    // reach the paths they are about.
    const STAMP = new Date("2026-07-29T12:00:00.000Z");

    const writeCross = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${CROSS_KEY}`, source);

    const captureCross = () => captureMissing(roots, [CROSS_TEST_KEY], STAMP);

    beforeEach(async () => {
      await writeCross(crossSource());
      await Deno.writeTextFile(
        `${dir}/patterns/${CROSS_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        crossTest,
      );
    });

    it("records the child under the space it was materialized in, and carries that space", async () => {
      const { problems, captured } = await captureCross();
      expect(problems).toEqual([]);
      expect(captured).toHaveLength(1);

      const [pinned] = await collectVintages(roots.vintagesRoot);
      const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-cross-" });
      const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
      try {
        const entries = (await readVintageManifest(vintage))?.entries ?? [];
        // The child's root is in the child's space, not the fixture's own. This
        // is the premise every case below rests on: if the capture stopped
        // producing a cross-space entry, they would all pass vacuously.
        const child = entries.find((e) => e.symbol === "Child");
        expect(child?.space).toBe(CHILD_SPACE);
        expect(child?.space).not.toBe(vintage.space);
        // ...and the fixture RESTORED it. A recorded space that did not travel
        // with the state is a root the replay cannot reach.
        expect([...vintage.restoredSpaces].sort()).toEqual(
          [CHILD_SPACE, signer.did()].sort(),
        );
      } finally {
        await vintage.dispose().catch(() => {});
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
      // On disk that is a companion store beside the primary file, named for
      // the space it holds.
      const companions: string[] = [];
      for await (
        const entry of Deno.readDir(vintageCompanionDir(pinned.path))
      ) {
        companions.push(entry.name);
      }
      expect(companions).toEqual([`${encodeURIComponent(CHILD_SPACE)}.sqlite`]);
    });

    it("reads the child's CAPTURED root, not an empty cell in the wrong space", async () => {
      // The case this whole block exists for. An entity id is content-derived
      // and carries no space, so reading the child's id under the FIXTURE's DID
      // is a lookup that succeeds at finding nothing: the cell is absent,
      // today's source materializes onto it, the root then holds today's
      // defaults, and the entry is counted as updated cleanly. Measured — with
      // the replay reading `vintage.space` this exact break replays with zero
      // failures.
      await captureCross();
      // The CHILD's recorded identity, from the manifest — not the fixture's
      // name, which is the TEST's identity now that a fixture is keyed by the
      // test that produced it and covers several patterns.
      const [pinned] = await collectVintages(roots.vintagesRoot);
      const childIdentity = await childRecordedIdentity(pinned.path);
      await writeCross(crossSource("string[]"));

      const { failures } = await replayAll(roots);

      const childFailure = failures.find((f) => f.detail.includes("(Child)"));
      expect(childFailure?.detail).toContain("was REFUSED");
      // The proof that the CAPTURED root was reached, and not some empty cell:
      // the root still carries the identity the capture stamped on it. A cell
      // in a space the fixture never wrote carries no marker at all — and would
      // have taken the migration without complaint.
      expect(childFailure?.detail).toContain(
        `the root carries ${childIdentity}#Child`,
      );
    });

    it("only WARNS on a moved storage key whose new slot is SEEDED", async () => {
      // A PINNED LIMIT, not a passing check. Read it before trusting a green
      // run over a pattern whose fields carry initial values.
      //
      // The gate fails on a stranded key only when the value went from
      // something to NOTHING — see `StateFinding`, and the measurements that
      // bought that grading: a replay recomputes as well as reads, so a derived
      // value the vintage never pulled on resolves to something better this
      // time and failing on it would red every real edit.
      //
      // A moved `.for()` key does not always read back as nothing. Here the
      // child seeds its cell (`new Writable<string>('captured')`), so the fresh
      // cell under the NEW name reads `"captured"` — non-empty, and therefore
      // graded as changed rather than lost. `"written"`, which a handler wrote
      // and the vintage held, is unreachable and the run is GREEN.
      //
      // The companion case is the one that still fails: an undeclared `notes`
      // moved to `notesMoved` reads back `[]`, and
      // "reports a key that rides an INDEX SIGNATURE" pins it. So the class is
      // caught when the new slot stays empty and warned when the pattern fills
      // it — which is the blind spot to close if this grading is ever revisited
      // (weighting by `of:` versus `computed:` backing is the candidate).
      //
      // What this shape still uniquely exercises, and must keep exercising:
      //
      // - the before-state is read in the CHILD's space. Read under the
      //   fixture's own DID it comes back absent, and an absent before-state is
      //   reported as unreadable rather than as loss — a different failure, for
      //   a different reason, which would pass for this one.
      // - the child's prior state is snapshotted before the PARENT is
      //   materialized. The parent's setup re-instantiates the child, so a
      //   before-read taken when the child's own turn came would be reading a
      //   root today's source had already rewritten, and the comparison would
      //   be against itself.
      await captureCross();
      await writeCross(crossSource().replace(".for('note')", ".for('moved')"));

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      let stranded: number;
      let failures: { detail: string }[];
      try {
        ({ stranded, failures } = await replayAll(roots));
      } finally {
        console.warn = originalWarn;
      }

      // Asserted rather than merely absent: the gate must still NOTICE, and a
      // change that stopped reading either root would produce no warning at
      // all — indistinguishable here from the limit being pinned.
      const childWarning = warnings.find((line) => line.includes("(Child)"));
      expect(
        childWarning,
        "the child's moved key produced no warning, so the comparison did not " +
          "read the child's root at all — the limit below would then be pinning " +
          "nothing",
      ).toBeDefined();
      expect(childWarning).toContain('note (was "written", now "captured")');
      // TWO roots examined for one move, pinned rather than loosened to "at
      // least one": the child's own root reports `note`, and the parent — whose
      // result projects the child's — reports `child`.
      const parentWarning = warnings.find((line) => line.includes("(default)"));
      expect(parentWarning).toContain("changed state the vintage held: child");

      // ...and the limit itself: nothing FAILED.
      expect(failures.filter((f) => f.detail.includes("stranded"))).toEqual([]);
      expect(stranded).toBe(0);
    });

    it("passes once the child's added field carries a default", async () => {
      // The green half of the pair. The two sources differ by exactly
      // `Default<[]>` on a field of the CHILD's output, so the failure above is
      // attributable to that and not to anything else about reaching another
      // space — and this direction proves the cross-space root is genuinely
      // migrated rather than merely reported on.
      await captureCross();
      await writeCross(crossSource("string[] | Default<[]>"));

      const { targets, changed, updated, failures } = await replayAll(roots);

      expect(failures).toEqual([]);
      // Both the parent and the child changed and both applied — `> 1` is what
      // keeps this from staying green if a future change stopped materializing
      // the cross-space root and only the entry pattern was applied.
      expect(targets).toBeGreaterThan(1);
      expect(changed).toBeGreaterThan(1);
      expect(updated).toBe(changed);
    });

    it("leaves NOTHING behind when a companion store cannot be written", async () => {
      // A fixture is written in pieces: the primary file, then one companion per
      // other space. A failure part way through is worse than no fixture at all
      // — `--update` only ever ADDS, so it would skip the key as already covered
      // and the partial would sit there being replayed forever.
      //
      // Forced through the layout rather than by stubbing: a stale companion
      // store at the destination makes `VACUUM INTO` refuse (its output file
      // must not exist), which is also the real hazard of a half-deleted
      // fixture.
      const first = await captureVintage(roots, CROSS_TEST_KEY, STAMP);
      await Deno.remove(first);

      await expect(captureVintage(roots, CROSS_TEST_KEY, STAMP)).rejects
        .toThrow();

      expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
      // The companion directory goes too. Leaving it would strand the next
      // capture on the same failure, with nothing on disk to explain why.
      await expect(Deno.stat(vintageCompanionDir(first))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    });

    it("refuses to write over a pinned vintage, rather than replacing it", async () => {
      // `--update` can only ADD: a command that could replace a fixture could
      // replace the very fixture that would have caught a break. The cleanup
      // above is why this is enforced HERE and not only in `captureMissing` —
      // a capture that wrote over someone else's state and then failed would
      // delete it on the way out.
      const first = await captureVintage(roots, CROSS_TEST_KEY, STAMP);
      const before = await Deno.stat(first);

      await expect(captureVintage(roots, CROSS_TEST_KEY, STAMP)).rejects
        .toThrow(
          "never overwrites a pinned vintage",
        );

      expect((await Deno.stat(first)).mtime).toEqual(before.mtime);
      expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
    });

    it("FAILS a fixture whose recorded root is not IN the space it carries", async () => {
      // Carrying the space is not the same claim as holding the root. A space
      // store that opened but never committed is a valid EMPTY database, so it
      // restores, `restoredSpaces` lists it, and every space-level check passes
      // — while the recorded cell is absent, the candidate materializes onto
      // nothing, and the entry counts as updated cleanly. Measured: without the
      // per-root control this replays the `string[]` break above with zero
      // failures.
      await captureCross();
      const [pinned] = await collectVintages(roots.vintagesRoot);
      const companion = `${vintageCompanionDir(pinned.path)}/${
        encodeURIComponent(CHILD_SPACE)
      }.sqlite`;
      await Deno.writeFile(companion, new Uint8Array());
      await writeCross(crossSource("string[]"));

      const { failures } = await replayAll(roots);

      const childFailure = failures.find((f) => f.detail.includes("#Child"));
      // Names the EVIDENCE the control looked for, so a doc that is present but
      // unstamped — the one shape a false red could take — reads differently
      // from a doc that is not there at all.
      expect(childFailure?.detail).toContain("no pattern setup marker");
      expect(childFailure?.detail).toContain("recorded but NOT validated");
      // NOT the missing-space diagnosis: the space is right there, empty. A
      // message that blamed the space would send the reader after the wrong
      // thing.
      expect(childFailure?.detail).not.toContain("does not carry");
    });

    it("FAILS a fixture that dropped a recorded space, rather than reading it clean", async () => {
      // The same worst-available-green as an unrestored fixture, one space in:
      // the primary store restores, every check about it passes, and the roots
      // in the missing space are silently not replayed. Today's source is left
      // UNCHANGED so nothing else can account for the failure — the fixture is
      // reported as under-covering on its own.
      await captureCross();
      const [pinned] = await collectVintages(roots.vintagesRoot);
      await Deno.remove(vintageCompanionDir(pinned.path), { recursive: true });

      const { replayed, failures } = await replayAll(roots);

      expect(replayed).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].detail).toContain(
        `was materialized in ${CHILD_SPACE}, which this fixture does not carry`,
      );
      expect(failures[0].detail).toContain("recorded but NOT validated");
    });
  });
});

describe("the stranded-value snippet", () => {
  it("never throws, whatever the value is", () => {
    // A report that can take the run down is a report that fails exactly when
    // it is needed. `JSON.stringify` throws on a `bigint` — a value a durable
    // doc may hold — and on anything cyclic, and both reach this on the one
    // path where a finding is being printed.
    expect(snippet(1n)).toBe('"1n"');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(typeof snippet(loop)).toBe("string");
    expect(snippet(undefined)).toBe("undefined");
  });

  it("keeps a finding short enough to read", () => {
    expect(snippet("x".repeat(500)).length).toBe(80);
  });
});
