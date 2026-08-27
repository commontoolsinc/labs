import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// The argument link-target pre-sync follows each root's declared schema:
// targets on schema-named paths are synced (reading through links, as deep as
// the declaration goes), an `asCell` path syncs its target without walking
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
    syncedIds.length = 0;
    await (runtime.runner as unknown as {
      syncArgumentLinkTargets(
        roots: readonly { cell: Cell<unknown>; schema?: JSONSchema }[],
        label: string,
      ): Promise<void>;
    }).syncArgumentLinkTargets(
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

  it("treats a union as a reference only when every arm is one", async () => {
    const { make, commit } = docBuilder("union arms");
    const behindOpaque = make("behind opaque", { n: 1 });
    const opaque = make("opaque", { child: behindOpaque });
    const behindReadable = make("behind readable", { n: 2 });
    const readable = make("readable", { child: behindReadable });
    const root = make("root", { allRef: opaque, mixed: readable });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        allRef: {
          anyOf: [
            { type: "object", asCell: ["cell"] },
            { type: "object", asCell: ["stream"] },
          ],
        },
        mixed: {
          anyOf: [
            { type: "object", asCell: ["cell"] },
            { type: "object", properties: { child: { type: "object" } } },
          ],
        },
      },
    } as JSONSchema);
    expect(syncedIds).toContain(id(opaque));
    expect(syncedIds).not.toContain(id(behindOpaque));
    expect(syncedIds).toContain(id(readable));
    expect(syncedIds).toContain(id(behindReadable));
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

  it("reads a union whose `oneOf` arm is readable beside a reference-only `anyOf`", async () => {
    const { make, commit } = docBuilder("both keywords");
    const behind = make("behind", { n: 1 });
    const target = make("target", { child: behind });
    const root = make("root", { both: target });
    await commit();
    await run(root, {
      type: "object",
      properties: {
        both: {
          anyOf: [{ type: "object", asCell: ["cell"] }],
          oneOf: [{
            type: "object",
            properties: { child: { type: "object" } },
          }],
        },
      },
    } as JSONSchema);
    // The `oneOf` arm is an alternative the run may take, so the link is not
    // reference-only and the document behind it is pre-synced.
    expect(syncedIds).toContain(id(target));
    expect(syncedIds).toContain(id(behind));
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
