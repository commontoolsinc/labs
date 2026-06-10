// End-to-end coverage for the WIRED my-car-demo org consumer
// (design-notes/my-car-profile-sharing). Compiles and RUNS the real
// packages/patterns/my-car-demo/main.tsx and asserts its GATED `allowedPlates`
// output — the trust rule (vouching.ts `allowedVehicles`) enforced by
// derivation INSIDE the compiled pattern, not just in unit tests.
//
// SCOPE — read honestly:
//   `allowedVehicles` has two legs. This test drives the wish-INDEPENDENT leg:
//   employee car-vouches (`activeCarVouchVehicles`) + the employee-author /
//   one-hop gate + time-boxing + roster revocation. All inputs (employees,
//   carVouches) are written into the compiled pattern's own perSpace cells and
//   the gated `allowedPlates` computed is read back.
//
//   The OTHER leg — self-claims gated by provenance — is fed by the internal
//   `#car` wish. A wish builtin only fires when something SUBSCRIBES it (the UI
//   in a real deploy); a wish consumed solely by result-level computeds does not
//   fire in a headless single runtime, so its claims never reach the gate here.
//   That real-wished-claim → gate path is covered by wish-profile-car.test.ts #3
//   (a real #car wish resolved through a subscribed result field, then run
//   through the same `toAuthoredClaims`/`allowedVehicles` gate).
//
// Mechanics: `allowedPlates` is a result-level `computed()` — a LAZY node under
// the scheduler's default pull mode — so `await demo.pull()` materializes it
// before each read (the run handle IS the result cell). CFC enforcement is
// disabled on the controlled txs (this checks the trust DERIVATION, not
// owner-integrity); owner-protected result projection otherwise aborts the
// run-commit without the trust ceremony. Time windows are relative to the
// demo's default clock (now=0): an "active" window brackets 0, "expired" ends
// before it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { plateKey } from "../../patterns/my-car-demo/classification.ts";

const ALICE = "did:key:alice"; // employee
const MALLORY = "did:key:mallory"; // not an employee

const vehicle = (plateId: string) => ({
  plateId,
  plateState: "CA",
  color: "",
  make: "",
  model: "",
});
const key = (plateId: string) => plateKey(plateId, "CA");

// Windows relative to the demo's default clock (now = 0).
const ACTIVE = { validFrom: -1000, validUntil: 1_000_000_000_000_000 };
const EXPIRED = { validFrom: -2000, validUntil: -1000 };
const carVouch = (
  voucher: string,
  plateId: string,
  window: { validFrom: number; validUntil: number },
) => ({ kind: "car", voucher, vehicle: vehicle(plateId), ...window });

describe("my-car-demo org consumer: gated allowedPlates via car-vouch leg (e2e, compiled pattern)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  // deno-lint-ignore no-explicit-any
  let demo: any;

  const edit = () => {
    tx = runtime.edit();
    tx.setCfcEnforcementMode("disabled");
    return tx;
  };

  beforeEach(async () => {
    const userIdentity = await Identity.fromPassphrase("my-car-demo-e2e-user");
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      experimental: { esmModuleLoader: true },
    });
    edit();

    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const sourcePath =
      new URL("../../patterns/my-car-demo/main.tsx", import.meta.url).pathname;
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, repoRoot),
    );
    const Demo = await runtime.patternManager.compilePattern(program);

    const demoResult = runtime.getCell(
      userIdentity.did(),
      "demo-e2e-result",
      undefined,
      tx,
    );
    demo = runtime.run(tx, Demo, {}, demoResult);
    await tx.commit();
    edit();
    await demo.pull();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  // `allowedPlates` is a lazy result computed — pull before reading.
  const allowed = async (): Promise<string[]> => {
    await demo.pull();
    return demo.key("allowedPlates").get() ?? [];
  };
  const setState = async (k: string, value: unknown) => {
    demo.withTx(tx).key(k).set(value);
    await tx.commit();
    await runtime.idle();
    edit();
    await demo.pull();
  };

  it("honors an in-window employee car-vouch, drops it when expired, and rejects a non-employee voucher", async () => {
    await setState("employees", [ALICE]);

    // In-window car-vouch by an employee → the guest car is allowed.
    await setState("carVouches", [carVouch(ALICE, "GUEST9", ACTIVE)]);
    expect(await allowed()).toContain(key("GUEST9"));

    // Expired car-vouch → dropped (time-boxing).
    await setState("carVouches", [carVouch(ALICE, "GUEST9", EXPIRED)]);
    expect(await allowed()).not.toContain(key("GUEST9"));

    // In-window but vouched by a NON-employee → not honored (employee-author gate).
    await setState("carVouches", [carVouch(MALLORY, "GUEST9", ACTIVE)]);
    expect(await allowed()).not.toContain(key("GUEST9"));
  });

  it("revokes vouched cars when the voucher is dropped from the roster", async () => {
    await setState("employees", [ALICE]);
    await setState("carVouches", [carVouch(ALICE, "GUEST9", ACTIVE)]);
    expect(await allowed()).toContain(key("GUEST9"));

    // Drop Alice from the roster → her vouch grants nothing (revocation).
    await setState("employees", []);
    expect(await allowed()).not.toContain(key("GUEST9"));
  });
});
