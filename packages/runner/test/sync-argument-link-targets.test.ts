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

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    syncedIds = [];
    const original = runtime.storageManager.syncCell.bind(
      runtime.storageManager,
    );
    (runtime.storageManager as unknown as {
      syncCell: (cell: Cell<unknown>) => Promise<Cell<unknown>>;
    }).syncCell = (cell) => {
      syncedIds.push(cell.getAsNormalizedFullLink().id);
      return original(cell);
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
});
