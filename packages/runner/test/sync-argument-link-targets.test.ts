import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  resetReaderSchemaPrecedenceConfig,
  setReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";

// The argument link-target pre-sync follows each root's declared schema:
// targets on schema-named paths are synced (reading through links, two link
// hops deep), an `asCell` path syncs its target without walking
// it, an unselected property is invisible, and a root whose declaration runs
// out falls back to the undeclared two-hop scan.

const signer = await Identity.fromPassphrase("sync argument link targets");
const space = signer.did();

describe("syncArgumentLinkTargets", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let syncedIds: string[];
  // One entry per raw value read the walk performs, which is one per subtree
  // it descends into — the observable that separates walking a subtree twice
  // from walking it once. Sync counts cannot show it: documents dedupe
  // separately, so a doubled walk syncs the same documents.
  let walkedIds: string[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    syncedIds = [];
    walkedIds = [];
    const original = runtime.storageManager.syncCell.bind(
      runtime.storageManager,
    );
    (runtime.storageManager as unknown as {
      syncCell: (cell: Cell<unknown>) => Promise<Cell<unknown>>;
    }).syncCell = (cell) => {
      syncedIds.push(cell.getAsNormalizedFullLink().id);
      return original(cell);
    };
    const originalFromLink = runtime.getCellFromLink.bind(runtime);
    const counted = new WeakSet<object>();
    (runtime as unknown as {
      getCellFromLink: (...args: unknown[]) => Cell<unknown>;
    }).getCellFromLink = (...args: unknown[]) => {
      const cell = originalFromLink(
        ...args as Parameters<typeof originalFromLink>,
      );
      if (!counted.has(cell)) {
        counted.add(cell);
        const originalGetRaw = cell.getRawUntyped.bind(cell);
        Object.defineProperty(cell, "getRawUntyped", {
          configurable: true,
          value: () => {
            walkedIds.push(cell.getAsNormalizedFullLink().id);
            return originalGetRaw();
          },
        });
      }
      return cell;
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // A root document holding links under `a`, `b`, and `hidden`; the document
  // behind `a` links onward to `deep`, and the one behind `b` to `behindB`.
  async function linkedFixture(prefix: string) {
    const tx = runtime.edit();
    const make = (name: string, value: unknown) => {
      const cell = runtime.getCell<unknown>(
        space,
        `${prefix} ${name}`,
        undefined,
        tx,
      );
      cell.set(value);
      return cell;
    };
    const deep = make("deep", { leaf: 1 });
    const behindB = make("behind b", { leaf: 2 });
    const a = make("a", { inner: deep });
    const b = make("b", { deeper: behindB });
    const hidden = make("hidden", { leaf: 3 });
    const root = make("root", { a, b, hidden });
    await tx.commit();
    const id = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;
    return {
      root,
      ids: {
        deep: id(deep),
        behindB: id(behindB),
        a: id(a),
        b: id(b),
        hidden: id(hidden),
      },
    };
  }

  async function run(root: Cell<unknown>, schema: JSONSchema | undefined) {
    // Both ledgers are scoped to the walk under test, so a fixture's own
    // reads and syncs never count toward an assertion about it.
    syncedIds.length = 0;
    walkedIds.length = 0;
    await runtime.runner.accessForTestingOnly.syncArgumentLinkTargets(
      [{ cell: root, schema }],
      "resumeArgumentLinkTargetSync",
    );
  }

  it("syncs targets on schema-named paths, reading through links, and skips unselected properties", async () => {
    const { root, ids } = await linkedFixture("named paths");
    await run(root, {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: { inner: { type: "number" } },
        },
      },
    });
    expect(syncedIds).toContain(ids.a);
    expect(syncedIds).toContain(ids.deep);
    expect(syncedIds).not.toContain(ids.b);
    expect(syncedIds).not.toContain(ids.hidden);
  });

  it("syncs an `asCell` path's target without walking its contents", async () => {
    const { root, ids } = await linkedFixture("as cell");
    await run(root, {
      type: "object",
      properties: {
        b: { type: "object", asCell: ["cell"] },
      },
    } as JSONSchema);
    expect(syncedIds).toContain(ids.b);
    expect(syncedIds).not.toContain(ids.behindB);
    expect(syncedIds).not.toContain(ids.a);
  });

  it("scans in full, two link hops deep, where the declaration runs out", async () => {
    const { root, ids } = await linkedFixture("true schema");
    await run(root, true);
    expect(syncedIds).toContain(ids.a);
    expect(syncedIds).toContain(ids.b);
    expect(syncedIds).toContain(ids.hidden);
    expect(syncedIds).toContain(ids.deep);
    expect(syncedIds).toContain(ids.behindB);
  });

  it("scans a schemaless root the same as a `true` one", async () => {
    const { root, ids } = await linkedFixture("no schema");
    await run(root, undefined);
    expect(syncedIds).toContain(ids.hidden);
    expect(syncedIds).toContain(ids.deep);
  });

  it("falls back to the full scan under an unstructured object schema", async () => {
    const { root, ids } = await linkedFixture("unstructured");
    await run(root, { type: "object" });
    expect(syncedIds).toContain(ids.a);
    expect(syncedIds).toContain(ids.hidden);
    expect(syncedIds).toContain(ids.deep);
  });

  // Builds documents for a test that needs its own shapes.
  function docBuilder(prefix: string) {
    const tx = runtime.edit();
    const make = (name: string, value: unknown) => {
      const cell = runtime.getCell<unknown>(
        space,
        `${prefix} ${name}`,
        undefined,
        tx,
      );
      cell.set(value);
      return cell;
    };
    return { make, commit: () => tx.commit() };
  }
  const id = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;

  it("walks a document a reference visit reached first, when a read-through path also declares it", async () => {
    const { make, commit } = docBuilder("reference then read");
    const inner = make("inner", { leaf: 1 });
    const shared = make("shared", { child: inner });
    const root = make("root", { ref: shared, read: shared });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        ref: { type: "object", asCell: ["cell"] },
        read: {
          type: "object",
          properties: { child: { type: "object" } },
        },
      },
    } as JSONSchema);
    expect(syncedIds).toContain(id(shared));
    expect(syncedIds).toContain(id(inner));
  });

  it("walks both subtrees when two links address different paths of one document", async () => {
    const { make, commit } = docBuilder("two paths");
    const leftLeaf = make("left leaf", { n: 1 });
    const rightLeaf = make("right leaf", { n: 2 });
    const shared = make("shared", {
      left: { l: leftLeaf },
      right: { r: rightLeaf },
    });
    const root = make("root", {
      a: shared.key("left"),
      b: shared.key("right"),
    });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        a: { type: "object", properties: { l: { type: "object" } } },
        b: { type: "object", properties: { r: { type: "object" } } },
      },
    });
    expect(syncedIds).toContain(id(leftLeaf));
    expect(syncedIds).toContain(id(rightLeaf));
  });

  it("treats a union as a reference when any arm carries the marker", async () => {
    const { make, commit } = docBuilder("union arms");
    const behindHandle = make("behind handle", { n: 1 });
    const handle = make("handle", { child: behindHandle });
    const behindPlain = make("behind plain", { n: 2 });
    const plain = make("plain", { child: behindPlain });
    const root = make("root", { optional: handle, readable: plain });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        // The shape a generated optional handle takes. `preferAsCellBranch`
        // hands the reader the `asCell` branch, so the run holds a handle
        // and never reads through it.
        optional: {
          anyOf: [
            { type: "object", asCell: ["cell"] },
            { type: "undefined" },
          ],
        },
        readable: {
          anyOf: [
            { type: "object", properties: { child: { type: "object" } } },
            { type: "undefined" },
          ],
        },
      },
    } as JSONSchema);
    expect(syncedIds).toContain(id(handle));
    expect(syncedIds).not.toContain(id(behindHandle));
    // No arm of the second union carries the marker, so it is read through.
    expect(syncedIds).toContain(id(plain));
    expect(syncedIds).toContain(id(behindPlain));
  });

  it("holds a value declared `unknown` in either spelling of `type`", async () => {
    const { make, commit } = docBuilder("unknown reference");
    const behindScalar = make("behind scalar", { n: 1 });
    const scalar = make("scalar", { child: behindScalar });
    const behindArray = make("behind array", { n: 2 });
    const array = make("array", { child: behindArray });
    const root = make("root", { scalar, array });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        // `unknown` asks for reference semantics: compared by identity, not
        // read through, opaque at this hop and every deeper one. The reader
        // honors both spellings of `type`, so the pre-sync has to as well,
        // or it warms documents a run declared it would never read.
        scalar: { type: "unknown" },
        array: { type: ["unknown", "string"] },
      },
    } as JSONSchema);
    expect(syncedIds).toContain(id(scalar));
    expect(syncedIds).not.toContain(id(behindScalar));
    expect(syncedIds).toContain(id(array));
    expect(syncedIds).not.toContain(id(behindArray));
  });

  it("treats an `asCell` marker behind a `$ref` as a reference, and an unresolvable `$ref` as readable", async () => {
    const { make, commit } = docBuilder("ref arms");
    const behindRef = make("behind ref", { n: 1 });
    const viaRef = make("via ref", { child: behindRef });
    const behindMissing = make("behind missing", { n: 2 });
    const viaMissing = make("via missing", { child: behindMissing });
    const root = make("root", { r: viaRef, m: viaMissing });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        r: { "$ref": "#/$defs/RefCell" },
        m: { "$ref": "#/$defs/Missing" },
      },
      "$defs": {
        RefCell: { type: "object", asCell: ["cell"] },
      },
    } as JSONSchema);
    // The resolved definition carries `asCell`: target synced, not walked.
    expect(syncedIds).toContain(id(viaRef));
    expect(syncedIds).not.toContain(id(behindRef));
    // An unresolvable reference is not a reference marker; the target is
    // walked under it (the schema resolves to nothing, so the scan falls
    // back rather than going opaque).
    expect(syncedIds).toContain(id(viaMissing));
    expect(syncedIds).toContain(id(behindMissing));
  });

  it("descends a subtree once when two declared paths link to it", async () => {
    const { make, commit } = docBuilder("diamond");
    const leaf = make("leaf", { n: 1 });
    const shared = make("shared", { child: leaf });
    const root = make("root", { left: shared, right: shared });
    await commit();
    const childSchema = {
      type: "object",
      properties: { child: { type: "object" } },
    } as JSONSchema;
    await run(root, {
      type: "object",
      properties: { left: childSchema, right: childSchema },
    } as JSONSchema);
    // Both arms of the diamond reach the same document at the same path.
    // Without the walk ledger the frontier carries that subtree twice and
    // descends it twice, which only the read count shows — the documents
    // themselves dedupe either way.
    expect(walkedIds.filter((each) => each === id(shared))).toHaveLength(1);
    expect(syncedIds).toContain(id(shared));
    expect(syncedIds).toContain(id(leaf));
  });

  it("sees a marker in the `oneOf` arms when a schema carries both keywords", async () => {
    const { make, commit } = docBuilder("both keywords");
    const behind = make("behind", { n: 1 });
    const target = make("target", { child: behind });
    const root = make("root", { both: target });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        both: {
          anyOf: [{
            type: "object",
            properties: { child: { type: "object" } },
          }],
          oneOf: [{ type: "object", asCell: ["cell"] }],
        },
      },
    } as JSONSchema);
    // Both keywords describe one set of alternatives, so the `oneOf` marker
    // counts: the target is synced as a handle and not read through. Letting
    // `anyOf` shadow `oneOf` would walk it instead.
    expect(syncedIds).toContain(id(target));
    expect(syncedIds).not.toContain(id(behind));
  });

  it("walks the same document at one path under two disjoint declarations", async () => {
    const { make, commit } = docBuilder("disjoint schemas");
    const leftLeaf = make("left leaf", { n: 1 });
    const rightLeaf = make("right leaf", { n: 2 });
    const shared = make("shared", { left: leftLeaf, right: rightLeaf });
    const root = make("root", { viaLeft: shared, viaRight: shared });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        viaLeft: { type: "object", properties: { left: { type: "object" } } },
        viaRight: { type: "object", properties: { right: { type: "object" } } },
      },
    } as JSONSchema);
    // One document, one path, two bindings that read different fields of it.
    // Neither walk stands in for the other, so both leaves are pre-synced.
    expect(syncedIds.filter((each) => each === id(shared))).toHaveLength(1);
    expect(syncedIds).toContain(id(leftLeaf));
    expect(syncedIds).toContain(id(rightLeaf));
  });

  it("descends a schema that declares `properties` without a `type`", async () => {
    const { make, commit } = docBuilder("no type");
    const leaf = make("leaf", { n: 1 });
    const target = make("target", { child: leaf });
    const root = make("root", { a: target });
    await commit();
    await run(root, {
      properties: { a: { properties: { child: {} } } },
    } as JSONSchema);
    // An eager read reaches these children even though `schemaAtPath` selects
    // none of them, so the pre-sync follows the declaration it can see.
    expect(syncedIds).toContain(id(target));
    expect(syncedIds).toContain(id(leaf));
  });

  it("applies `items` to an array index when the schema omits `type`", async () => {
    const { make, commit } = docBuilder("items fallback");
    const leaf = make("leaf", { n: 1 });
    const element = make("element", { child: leaf });
    const root = make("root", { list: [element] });
    await commit();
    await run(root, {
      type: "object",
      properties: { list: { items: { properties: { child: {} } } } },
    } as JSONSchema);
    // `schemaAtPath` selects no child for a schema that declares `items` and
    // omits `type: "array"`, so the index resolves through the same fallback
    // the reader uses — and the walk follows the element's own declaration.
    expect(syncedIds).toContain(id(element));
    expect(syncedIds).toContain(id(leaf));
  });

  it("does not treat an out-of-range numeric property as an array item", async () => {
    const { make, commit } = docBuilder("non-index property");
    const leaf = make("leaf", { n: 1 });
    const root = make("root", { "4294967295": leaf });
    await commit();
    await run(root, {
      items: { type: "object" },
    } as JSONSchema);
    // 2^32 - 1 is an ordinary property name, not an array index. The reader's
    // child-schema fallback therefore does not apply `items` to it, and the
    // pre-sync must leave the same property unselected.
    expect(syncedIds).not.toContain(id(leaf));
  });

  it("keeps two subtrees apart when one path segment contains a separator", async () => {
    const { make, commit } = docBuilder("path collision");
    const nestedLeaf = make("nested leaf", { n: 1 });
    const slashLeaf = make("slash leaf", { n: 2 });
    const shared = make("shared", {
      a: { b: nestedLeaf },
      "a/b": slashLeaf,
    });
    await commit();
    const root = (() => {
      const b = docBuilder("path collision root");
      const cell = b.make("root", {
        nested: shared.key("a").key("b"),
        slashed: shared.key("a/b"),
      });
      return { cell, commit: b.commit };
    })();
    await root.commit();
    await run(root.cell, {
      type: "object",
      properties: {
        nested: { type: "object" },
        slashed: { type: "object" },
      },
    } as JSONSchema);
    // `["a", "b"]` and `["a/b"]` are different subtrees; a joined key would
    // collapse them and drop the second.
    expect(syncedIds).toContain(id(nestedLeaf));
    expect(syncedIds).toContain(id(slashLeaf));
  });

  it("holds an `unknown`-typed link as a reference instead of reading through it", async () => {
    const { make, commit } = docBuilder("unknown ref");
    const behind = make("behind", { n: 1 });
    const referenced = make("referenced", { child: behind });
    const root = make("root", { mention: referenced });
    await commit();
    await run(root, {
      type: "object",
      properties: { mention: { type: "unknown" } },
    } as JSONSchema);
    // `unknown` asks for reference semantics: the value is compared by
    // identity, never read through, and stays opaque at every deeper hop.
    expect(syncedIds).toContain(id(referenced));
    expect(syncedIds).not.toContain(id(behind));
  });

  it("adopts a link's own schema when the reader brought no shape", async () => {
    const { make, commit } = docBuilder("schema lineage");
    const wanted = make("wanted", { n: 1 });
    const unwanted = make("unwanted", { n: 2 });
    const target = make("target", { a: wanted, b: unwanted });
    const typed = target.asSchema({
      type: "object",
      properties: { a: { type: "object" } },
    } as JSONSchema);
    const root = make("root", { child: typed });
    await commit();
    await run(root, true);
    // A permissive reader is typed by the link it crosses, so the walk
    // follows that declaration rather than scanning everything behind it:
    // `a` is selected, `b` is not.
    expect(syncedIds).toContain(id(target));
    expect(syncedIds).toContain(id(wanted));
    expect(syncedIds).not.toContain(id(unwanted));
  });

  it("still covers the declared read surface under the rollback posture", async () => {
    setReaderSchemaPrecedenceConfig(false);
    try {
      const { root, ids } = await linkedFixture("rollback posture");
      await run(root, {
        type: "object",
        properties: {
          a: { type: "object", properties: { inner: { type: "number" } } },
        },
      });
      // With reader precedence off, crossings go back to the strict
      // pseudo-intersection, which can only widen what the walk carries —
      // so the declared surface stays covered.
      expect(syncedIds).toContain(ids.a);
      expect(syncedIds).toContain(ids.deep);
    } finally {
      resetReaderSchemaPrecedenceConfig();
    }
  });

  it("gives an undeclared subtree below a declared root the two-hop budget", async () => {
    const { make, commit } = docBuilder("budget");
    const third = make("third", { n: 3 });
    const second = make("second", { c: third });
    const first = make("first", { c: second });
    const root = make("root", { sub: { c: first } });
    await commit();
    await run(root, {
      type: "object",
      properties: { sub: true },
    });
    expect(syncedIds).toContain(id(first));
    expect(syncedIds).toContain(id(second));
    expect(syncedIds).not.toContain(id(third));
  });
});
