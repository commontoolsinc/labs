// Option-2 verification (my-car worked example, design-notes/my-car-profile-sharing):
// proves the previously-unverified cross-space link — a profile element tagged
// `userTags: ["car"]` is resolved by `wish({ query: "#car", scope: ["profile"] })`
// and the consumer can read its `selfClaims` output field.
//
// SINGLE runtime on purpose: this sidesteps CT-1658 (the owner-protected-array
// write bug, which only manifests across the server↔browser bundleId boundary)
// and gives deterministic, browser-free regression coverage of the profile-scope
// wish round-trip. Modeled on the scope tests in wish.test.ts.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";

describe("wish #car profile-scope round-trip", () => {
  let userIdentity: Identity;
  let profileSpace: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(async () => {
    userIdentity = await Identity.fromPassphrase("my-car-profile-user");
    profileSpace = await Identity.fromPassphrase("my-car-profile-space");
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves a #car profile element and reads its selfClaims", async () => {
    const claim = {
      vehicle: {
        plateId: "7ABC123",
        plateState: "CA",
        color: "Black",
        make: "Subaru",
        model: "Outback",
      },
      claimType: "self",
      claimedAt: 1,
    };

    // 1) A "MyCar"-shaped element cell living in the user's profile space: a cell
    //    whose value exposes `selfClaims` (the field the #car consumer reads).
    const carCell = runtime.getCell(
      profileSpace.did(),
      "my-car-element",
      undefined,
      tx,
    );
    carCell.set({ selfClaims: [claim] });

    // 2) The profile default pattern cell (in the profile space) with an
    //    `elements` array referencing the car cell, tagged `userTags: ["car"]`.
    const profileDefaultCell = runtime.getCell(
      profileSpace.did(),
      "profile-default",
      undefined,
      tx,
    );
    profileDefaultCell.set({
      elements: [{ cell: carCell, tag: "my-car", userTags: ["car"] }],
    });

    // Commit the profile-space writes first — a transaction may only write ONE
    // space (the cross-space write-isolation guard).
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    // 3) Wire the user's home → profile link that getProfileDefaultCell reads:
    //    homeSpaceCell.defaultPattern.profile -> the profile default cell
    //    (cross-space link, no path). Home-space writes only, in their own tx.
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultPatternCell = runtime.getCell(
      userIdentity.did(),
      "home-default-pattern",
      undefined,
      tx,
    );
    (homeDefaultPatternCell as any).key("profile").set(profileDefaultCell);
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    // 4) The consumer: wish for #car at profile scope (what parking-coordinator
    //    / lot-watch do).
    const wishPattern = pattern(() => {
      return { result: wish({ query: "#car", scope: ["profile"] }) };
    });
    const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
      profileSpace.did(),
      "car-wish-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

    const wishResult = result.key("result").get();
    if (wishResult?.error) {
      throw new Error(`wish error: ${JSON.stringify(wishResult.error)}`);
    }
    const resolved = wishResult?.result as any;
    expect(resolved).toBeDefined();
    const data = resolved?.get?.() ?? resolved;
    expect(data.selfClaims).toBeDefined();
    expect(data.selfClaims.length).toBe(1);
    expect(data.selfClaims[0].vehicle.plateId).toBe("7ABC123");
  });
});
