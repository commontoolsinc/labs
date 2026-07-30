import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { collectVintages, PINNED } from "./pattern-vintage-lib.ts";
import {
  openFileBackedRuntime,
  readVintageManifest,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import {
  captureMissing,
  type GateRoots,
  isUpgradeTarget,
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
    // ONE reason it replays clean, and it is the whole remaining gap:
    // `replayVintage` asks only whether the materialize was refused, never
    // whether the values survived it. The fixture genuinely holds stranded data
    // — capture drives the pattern through its own tests, so `items` was
    // written through a real handler before the key moved — which is what makes
    // this a pinned limit of the CHECK rather than of the fixture.
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

  it("FAILS a fixture holding a root it cannot map to a file", async () => {
    // Narrowed coverage must not read as success. The replay SKIPS an entry with
    // no source path, so a green verdict would be a claim about fewer roots than
    // the fixture holds — the shape this tier has mistaken for a pass three
    // times. Capture refuses to create one of these, so it is written directly.
    await captureMissing(roots, [KEY], new Date("2026-07-29T12:00:00.000Z"));
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
      ]);
      // To a fresh path, not over the file this runtime opened FROM — sqlite
      // refuses that — then swapped in once the handles are closed.
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { unmappable, failures } = await replayAll(roots);

    // Both shapes count: no source path at all, and a path that is not
    // repo-root-relative (the evaluate loop records injected helper modules
    // like `cfc.ts`, whose names carry no leading slash).
    expect(unmappable).toBe(2);
    expect(failures).toHaveLength(2);
    const details = failures.map((f) => f.detail).join("\n");
    expect(details).toContain("__cfPattern_9");
    expect(details).toContain("no source path");
    expect(details).toContain("__cfPattern_10");
    expect(details).toContain("is not repo-root-relative");
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
        [KEY],
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
        [KEY],
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
        [NESTED_KEY],
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
        [NESTED_KEY],
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
        [NESTED_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ALIASED_FLIPPED);

      const { changed, failures } = await replayAll(roots);

      expect(changed).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    });

    it("FAILS CLOSED when a stored root names an artifact this version dropped", async () => {
      // Renaming the exported sub-pattern leaves a root naming a symbol today's
      // module does not define. Falling back to the entry export would quietly
      // validate the wrong artifact; the honest answer is a reported finding.
      await captureMissing(
        roots,
        [NESTED_KEY],
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
});
