import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isStream, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  projectWishValue,
  readWish,
  resolveWish,
  WISH_STREAM_MARKER,
} from "../lib/wish.ts";
import { safeStringify } from "../lib/render.ts";

// Exercises the headless wish read core (`resolveWish`) against an emulated
// runtime — no live server. The full `readWish` (which adds a session-backed
// `loadManager`) is covered by the integration lane. These tests assert that the
// blessed read resolves through the SAME builtin resolution the runtime uses:
// a profile object, a profile scalar, and the zero-profile error path.

const userIdentity = await Identity.fromPassphrase("cf-wish-test-user");

describe("cf wish headless read (resolveWish)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // Seed a single profile (in its own space) into the user's home
  // `defaultPattern.profiles` list, mirroring the multi-profile home model.
  async function seedProfile(): Promise<void> {
    const profileSpaceDid =
      (await Identity.fromPassphrase("cf-wish-test-profile-space")).did();

    // A transaction has a single writer space, so seed the profile's own space
    // and the home space in separate committed transactions.
    let tx = runtime.edit();
    const profileSpaceCell = runtime.getSpaceCell(
      profileSpaceDid,
      undefined,
      tx,
    );
    const profileDefaultCell = runtime.getCell(
      profileSpaceDid,
      "profile-default",
      undefined,
      tx,
    );
    profileDefaultCell.set({
      name: "Ada Lovelace",
      initialNameApplied: "Ada Lovelace",
      avatar: "ada.png",
      bio: "Mathematician & first programmer.",
      elements: [],
    });
    profileSpaceCell.key("defaultPattern").set(profileDefaultCell);
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultCell = runtime.getCell(
      userIdentity.did(),
      "home-default-profile-link",
      undefined,
      tx,
    );
    homeDefaultCell.key("profiles").set([
      runtime.getCell(profileSpaceDid, "profile-default", undefined, tx),
    ]);
    // deno-lint-ignore no-explicit-any
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
    await tx.commit();
    await runtime.idle();
  }

  it("resolves #profile to the default profile object", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
    });
    expect(error).toBeUndefined();
    expect((result as { name?: string })?.name).toBe("Ada Lovelace");
    expect((result as { bio?: string })?.bio).toBe(
      "Mathematician & first programmer.",
    );
  });

  it("resolves the #profileName scalar target", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profileName",
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
  });

  it("returns a clear error and null result when no profile exists", async () => {
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
    });
    expect(result).toBeNull();
    expect(error).toBe("No profile exists yet");
  });

  it("appends extra path segments to the resolved target", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      path: ["bio"],
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Mathematician & first programmer.");
  });

  it("projects the result through a provided schema", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    });
    expect(error).toBeUndefined();
    expect((result as { name?: string })?.name).toBe("Ada Lovelace");
  });

  it("projectWishValue strips stream handles but keeps profile data (CT-1844)", () => {
    // Build a profile-shaped result carrying a REAL stream handle alongside its
    // data fields, exactly as a materialized #profile object does.
    const tx = runtime.edit();
    const cell = runtime.getCell<{
      name: string;
      avatar: string;
      bio: string;
      isEditing: boolean;
      elements: { title: string }[];
      $UI: { type: string; name: string };
      setName: { $stream: boolean };
    }>(userIdentity.did(), "ct1844-projection-fixture", undefined, tx);
    cell.set({
      name: "Ada Lovelace",
      avatar: "ada.png",
      bio: "Mathematician & first programmer.",
      isEditing: false,
      elements: [{ title: "Note" }],
      $UI: { type: "vnode", name: "cf-screen" },
      setName: { $stream: true },
    });
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        avatar: { type: "string" },
        bio: { type: "string" },
        isEditing: { type: "boolean" },
        elements: { type: "array" },
        $UI: { type: "object" },
        setName: { type: "object", asCell: ["stream"] },
      },
    } as const satisfies JSONSchema;
    const value = cell.asSchema(schema).get();
    // Sanity: the raw value really does carry a live stream handle.
    expect(isStream(value.setName)).toBe(true);

    const projected = projectWishValue(value) as Record<string, unknown>;

    // Data fields survive, including the nested `elements` array and $UI VNode.
    expect(projected.name).toBe("Ada Lovelace");
    expect(projected.avatar).toBe("ada.png");
    expect(projected.bio).toBe("Mathematician & first programmer.");
    expect(projected.isEditing).toBe(false);
    expect(projected.elements).toEqual([{ title: "Note" }]);
    expect(projected.$UI).toEqual({ type: "vnode", name: "cf-screen" });

    // The stream handle is replaced by a stable marker — no runtime graph.
    expect(projected.setName).toBe(WISH_STREAM_MARKER);

    // The serialized output stays small and free of the runtime object graph.
    const json = safeStringify(projected);
    expect(json.length).toBeLessThan(2000);
    expect(json).not.toContain("scheduler");
    expect(json).not.toContain("circular reference");
    expect(json).not.toContain("runtime");
  });

  it("projectWishValue passes scalar targets through unchanged (CT-1844)", () => {
    // #profileName and friends resolve to a bare scalar — untouched.
    expect(projectWishValue("Ada Lovelace")).toBe("Ada Lovelace");
    expect(projectWishValue(42)).toBe(42);
    expect(projectWishValue(true)).toBe(true);
    expect(projectWishValue(null)).toBe(null);
  });

  it("readWish connects through the injected manager and resolves", async () => {
    await seedProfile();
    const seen: string[] = [];
    const { result, error } = await readWish(
      {
        apiUrl: "http://127.0.0.1:8000",
        space: "ignored-by-fake",
        identity: "/nonexistent.key",
        query: "#profileName",
      },
      {
        loadManager: (config) => {
          seen.push(config.apiUrl, config.space);
          return Promise.resolve({
            runtime,
            getSpace: () => userIdentity.did(),
          });
        },
      },
    );
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
    // The wrapper passes the connection config through to the dep.
    expect(seen).toEqual(["http://127.0.0.1:8000", "ignored-by-fake"]);
  });
});
