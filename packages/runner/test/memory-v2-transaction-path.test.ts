import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("memory-v2-transaction-path");
const space = signer.did();

describe("memory v2 transaction path semantics", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("preserves sibling fields across repeated path writes", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-repeat",
      path: [],
    }, {
      count: 0,
      label: "bench",
      nested: { value: 1 },
    });

    for (let index = 0; index < 10; index += 1) {
      tx.writeValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-repeat",
        path: ["count"],
      }, index);
    }

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-repeat",
        path: [],
      }),
    ).toEqual({
      count: 9,
      label: "bench",
      nested: { value: 1 },
    });

    await tx.commit();
  });

  it("returns undefined for a missing leaf but errors on a missing parent", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: [],
    }, {
      nested: { value: 1 },
    });

    const missingLeaf = tx.read({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: ["nested", "missing"],
    });
    expect(missingLeaf.ok?.value).toBeUndefined();

    const missingParent = tx.read({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: ["nested", "missing", "leaf"],
    });
    expect(missingParent.error?.name).toBe("NotFoundError");

    await tx.commit();
  });

  it("creates missing parent objects without clobbering siblings", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-missing-parent",
      path: [],
    }, {
      count: 0,
      nested: {},
    });

    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-missing-parent",
      path: ["details", "profile", "name"],
    }, "Ada");

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-missing-parent",
        path: [],
      }),
    ).toEqual({
      count: 0,
      nested: {},
      details: {
        profile: {
          name: "Ada",
        },
      },
    });

    await tx.commit();
  });

  it("preserves siblings across mixed object and array path writes", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: [],
    }, {
      profile: { name: "Ada" },
      items: [{ label: "one" }],
    });

    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: ["items", "1", "label"],
    }, "two");
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: ["details", "flags", "active"],
    }, true);

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-mixed-branches",
        path: [],
      }),
    ).toEqual({
      profile: { name: "Ada" },
      items: [{ label: "one" }, { label: "two" }],
      details: {
        flags: {
          active: true,
        },
      },
    });

    await tx.commit();
  });

  it("delete-of-nonexistent: writing undefined at a missing path is a no-op (does not create intermediates)", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-delete-nonexistent",
      path: [],
    }, {
      kept: "intact",
    });

    // Attempt to "delete" a slot that doesn't exist. Should leave the doc
    // unchanged -- no `details` container materialized, `kept` preserved.
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-delete-nonexistent",
      path: ["details", "profile", "name"],
    }, undefined);

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-delete-nonexistent",
        path: [],
      }),
    ).toEqual({ kept: "intact" });
    // The intermediates should NOT have been allocated.
    expect(
      tx.read({
        space,
        scope: "space",
        id: "of:path-delete-nonexistent",
        path: ["details"],
      }).ok?.value,
    ).toBeUndefined();

    tx.abort();
  });

  it("writes the same value at the same path as a no-op (identity-preserving)", () => {
    const tx = runtime.edit();
    const initial = { count: 1, label: "one" };
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }, initial);

    const before = tx.read({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }).ok?.value;

    // Write a deep-equal but distinct-reference object at the same path.
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }, { count: 1, label: "one" });

    const after = tx.read({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }).ok?.value;

    // Identity preserved across the no-op write.
    expect(after).toBe(before);

    tx.abort();
  });

  it("write through a primitive intermediate fails with a TypeMismatchError on the offending path", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-typemismatch",
      path: [],
    }, {
      // `name` is a string -- writing /name/whatever should fail with a type
      // mismatch, not silently overwrite or create children.
      name: "Ada",
    });

    const result = tx.write({
      space,
      scope: "space",
      id: "of:path-typemismatch",
      path: ["value", "name", "deeper"],
    }, "should fail");
    expect(result.error?.name).toBe("TypeMismatchError");

    // The doc should be unchanged.
    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-typemismatch",
        path: [],
      }),
    ).toEqual({ name: "Ada" });

    tx.abort();
  });

  it("nested write into a fresh doc materializes the doc value at the root", () => {
    // The whole doc value is what just came into existence; the activity
    // path for subscribers watching the root should reflect that
    // (regression for the `findMaterializedParentPath` "currentRoot is
    // undefined" case, which previously failed to fire for path length 1
    // -- the storage-boundary "value" prefix makes single-segment user
    // writes hit that path length).
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-initial-nested",
      path: [],
    }, { title: "Hello", nested: { count: 0 } });

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-initial-nested",
        path: ["nested", "count"],
      }),
    ).toEqual(0);

    tx.abort();
  });
});
