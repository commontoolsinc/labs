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
        id: "of:path-write-repeat",
        path: ["count"],
      }, index);
    }

    expect(
      tx.readValueOrThrow({
        space,
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
      id: "of:path-read-missing",
      path: [],
    }, {
      nested: { value: 1 },
    });

    const missingLeaf = tx.read({
      space,
      id: "of:path-read-missing",
      path: ["nested", "missing"],
    });
    expect(missingLeaf.ok?.value).toBeUndefined();

    const missingParent = tx.read({
      space,
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
      id: "of:path-write-missing-parent",
      path: [],
    }, {
      count: 0,
      nested: {},
    });

    tx.writeValueOrThrow({
      space,
      id: "of:path-write-missing-parent",
      path: ["details", "profile", "name"],
    }, "Ada");

    expect(
      tx.readValueOrThrow({
        space,
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
      id: "of:path-write-mixed-branches",
      path: [],
    }, {
      profile: { name: "Ada" },
      items: [{ label: "one" }],
    });

    tx.writeValueOrThrow({
      space,
      id: "of:path-write-mixed-branches",
      path: ["items", "1", "label"],
    }, "two");
    tx.writeValueOrThrow({
      space,
      id: "of:path-write-mixed-branches",
      path: ["details", "flags", "active"],
    }, true);

    expect(
      tx.readValueOrThrow({
        space,
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
});
