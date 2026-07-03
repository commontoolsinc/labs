import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveWish } from "../lib/wish.ts";

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
});
