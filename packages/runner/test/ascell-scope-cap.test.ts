// An `asCell` entry's `scope` is a follow cap: it bounds which link scopes a
// read arriving through that schema may follow (ContextualFlowControl
// .getSchemaScopeCap). It is what lets a space-scoped list require that every
// handle in it points somewhere every reader in the space can resolve.
//
// The cap has to mean the same thing however the handle is reached. These tests
// pin the three routes to one answer:
//
//   1. the value projection            -- cell.key("handle").get()
//   2. a key() chain past the handle   -- cell.key("handle", "field").get()
//   3. an explicit dereference         -- cell.key("handle").resolveAsCell()
//
// Before #5230 only (3) consulted the cap: (1) never checked it, and (2) lost
// it because key() narrows through getSchemaAtPath, which drops the ancestor's
// asCell entry, leaving resolveLink's schemaScopeForLink() with nothing to
// check one hop later.
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema, SchemaScope } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ascell scope cap");
const space = signer.did();

const innerSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

describe("asCell scope cap", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Build `{ handle: <link to a cell in `targetScope`> }` where `handle`'s
   * asCell entry declares `cap`, and return the three routes to the handle.
   */
  const build = (
    label: string,
    cap: SchemaScope | undefined,
    targetScope: "space" | "user" | "session",
  ) => {
    const inner = runtime.getCell(
      space,
      `cap-inner-${label}`,
      innerSchema,
      tx,
      targetScope,
    );
    inner.set({ field: "secret" });

    const outer = runtime.getCell(
      space,
      `cap-outer-${label}`,
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: cap === undefined
              ? ["cell"]
              : [{ kind: "cell", scope: cap }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    const projected = outer.key("handle").get();
    return {
      outer,
      // 1. value projection: the Cell the asCell slot materializes to
      projection: isCell(projected)
        ? (projected as { get(): unknown }).get()
        : projected,
      // 2. key() chain continuing past the handle
      through: outer.key("handle", "field").get(),
      // 3. explicit dereference
      dereferenced: outer.key("handle").resolveAsCell().key("field").get(),
    };
  };

  it("blocks every route when the cap is narrower than the link", () => {
    // handle caps follows at `space`; the stored link is session-scoped.
    const r = build("blocked", "space", "session");
    expect(r.dereferenced).toBeUndefined();
    expect(r.through).toBeUndefined();
    expect(r.projection).toBeUndefined();
  });

  it("allows every route when the cap admits the link's scope", () => {
    // A session cap is permissive: it admits space, user and session links.
    const r = build("permitted", "session", "session");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
  });

  it("allows every route when no cap is declared", () => {
    const r = build("uncapped", undefined, "session");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
  });

  it("allows every route when the link is no narrower than the cap", () => {
    const r = build("same-scope", "space", "space");
    expect(r.dereferenced).toBe("secret");
    expect(r.through).toBe("secret");
    expect(r.projection).toEqual({ field: "secret" });
  });

  it("keeps the cap reachable after key() narrows past the handle", () => {
    const inner = runtime.getCell(
      space,
      "cap-schema-inner",
      innerSchema,
      tx,
      "session",
    );
    inner.set({ field: "secret" });
    const outer = runtime.getCell(
      space,
      "cap-schema-outer",
      {
        type: "object",
        properties: {
          handle: {
            ...innerSchema,
            asCell: [{ kind: "cell", scope: "space" }],
          },
        },
        required: ["handle"],
      } as JSONSchema,
      tx,
    );
    outer.set({ handle: inner } as never);

    // The cap is visible on the handle itself...
    expect(
      ContextualFlowControl.getSchemaScopeCap(outer.key("handle").schema),
    ).toBe("space");
    // ...and the leaf schema below it legitimately carries no cap of its own,
    // so the link has to remember the one declared at depth 1.
    expect(
      ContextualFlowControl.getSchemaScopeCap(
        outer.key("handle", "field").schema,
      ),
    ).toBeUndefined();
    expect(
      outer.key("handle", "field").getAsNormalizedFullLink().scopeCaps,
    ).toEqual([{ depth: 1, scope: "space" }]);
  });
});
