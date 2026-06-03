// Runner-level coverage for the my-car worked example's #car profile-scope wish
// (design-notes/my-car-profile-sharing). Read the two tests honestly:
//
//  1. `resolves a #car-tagged profile element and reads selfClaims` — GREEN, but
//     NARROW. It proves only that `wish({ query: "#car", scope: ["profile"] })`
//     resolves a profile element over the real home→profile link and the consumer
//     can read its `selfClaims` field. The element is a hand-built DATA CELL
//     stub — it does NOT instantiate MyCar, go through profile-home's add flow,
//     or exercise owner-protected writes / provenance / classification / vouch /
//     reveal. It is a wish-resolution smoke test, not a full round-trip.
//
//  2. `real compiled MyCar: its selfClaims resolve through the #car wish` — GREEN.
//     The genuine end-to-end: compile the real packages/patterns/my-car/main.tsx,
//     RUN it, author a claim into its owner-protected `selfClaims`, register the
//     LIVE instance as a #car profile element, and resolve it via the real #car
//     wish. CFC enforcement is DISABLED on the controlled txs because this checks
//     the cross-space DATA round-trip, not owner-integrity (covered by
//     profile-owner-cfc.test.ts + the emitted-ifc check in my-car/main.test.tsx);
//     owner-protected outputs otherwise abort the commit without the trust
//     ceremony — which is what the earlier "output not materializing" was.
//     Building this paid off twice: it surfaced the SES re-export bug
//     (CT-1661 — MyCar re-exporting its claims.ts surface created live bindings
//     the SES verifier rejects under the ESM loader; fixed by dropping the
//     re-exports), and it confirmed the real producer→profile→wish chain resolves.
//     Single runtime is deliberate (sidesteps CT-1658, a server↔browser
//     bundleId mismatch).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { createBuilder } from "../src/builder/factory.ts";

describe("wish #car profile-scope", () => {
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
      // Multi-file compiled patterns (MyCar imports vehicles.ts + claims.ts) run
      // through the ESM module-record loader; single runtime so CT-1658 (a
      // server↔browser bundleId mismatch) cannot trigger.
      experimental: { esmModuleLoader: true },
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

  // Wire the user's home → profile link (cross-space, separate txs) with the
  // given profile-default value, and run a #car consumer; return the wish result.
  const wishCarAfterProfile = async (
    profileDefaultValue: unknown,
  ) => {
    const profileDefaultCell = runtime.getCell(
      profileSpace.did(),
      "profile-default",
      undefined,
      tx,
    );
    profileDefaultCell.set(profileDefaultValue);
    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

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
    return result.key("result").get();
  };

  it("resolves a #car-tagged profile element and reads selfClaims (narrow: stub element)", async () => {
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
    const carCell = runtime.getCell(
      profileSpace.did(),
      "my-car-element",
      undefined,
      tx,
    );
    carCell.set({ selfClaims: [claim] });

    const wishResult = await wishCarAfterProfile({
      elements: [{ cell: carCell, tag: "my-car", userTags: ["car"] }],
    });
    if (wishResult?.error) {
      throw new Error(`wish error: ${JSON.stringify(wishResult.error)}`);
    }
    const resolved = wishResult?.result as any;
    expect(resolved).toBeDefined();
    const data = resolved?.get?.() ?? resolved;
    expect(data.selfClaims?.[0]?.vehicle?.plateId).toBe("7ABC123");
  });

  // The real round-trip: compile the actual packages/patterns/my-car/main.tsx,
  // RUN it, author a claim into its owner-protected selfClaims, register the LIVE
  // instance as a #car profile element, and resolve it through the real #car wish.
  //
  // CFC enforcement is DISABLED on the txs we control: this test verifies the
  // cross-space DATA round-trip (a live MyCar resolved by the wish, its selfClaims
  // read), NOT owner-integrity enforcement — which is covered by
  // profile-owner-cfc.test.ts and the emitted-ifc check in my-car/main.test.tsx.
  // Owner-protected outputs otherwise abort the commit (the run's own commit, and
  // any selfClaims write) without the full CFC trust ceremony.
  it("real compiled MyCar: its selfClaims resolve through the #car wish", async () => {
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const sourcePath =
      new URL("../../patterns/my-car/main.tsx", import.meta.url).pathname;
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, repoRoot),
    );
    const MyCar = await runtime.patternManager.compilePattern(program);

    const myCarCell = runtime.getCell(
      profileSpace.did(),
      "my-car-instance",
      undefined,
      tx,
    );
    tx.setCfcEnforcementMode("disabled");
    const myCar = runtime.run(tx, MyCar, {}, myCarCell);
    await tx.commit();
    await runtime.idle();

    // Author a claim into the live MyCar's owner-protected selfClaims.
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
    tx = runtime.edit();
    tx.setCfcEnforcementMode("disabled");
    myCarCell.withTx(tx).key("selfClaims").set([claim]);
    await tx.commit();
    await runtime.idle();

    // The live instance exposes the claim.
    tx = runtime.edit();
    const out = myCar.withTx(tx).get() as {
      selfClaims?: Array<{ vehicle?: { plateId?: string } }>;
    };
    expect(out.selfClaims?.[0]?.vehicle?.plateId).toBe("7ABC123");

    // The org-side #car wish resolves the LIVE MyCar element and reads selfClaims.
    const wishResult = await wishCarAfterProfile({
      elements: [{ cell: myCarCell, tag: "my-car", userTags: ["car"] }],
    });
    if (wishResult?.error) {
      throw new Error(`wish error: ${JSON.stringify(wishResult.error)}`);
    }
    const resolved = wishResult?.result as any;
    expect(resolved).toBeDefined();
    const data = resolved?.get?.() ?? resolved;
    expect(data.selfClaims?.[0]?.vehicle?.plateId).toBe("7ABC123");
  });
});
