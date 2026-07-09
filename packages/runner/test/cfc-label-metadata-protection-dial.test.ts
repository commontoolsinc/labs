import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../src/runtime.ts";
import type { CfcLabelMetadataProtectionMode } from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-metadata-protection-dial",
);

// Inv-12 Stage 1 (SC-25): the `cfcLabelMetadataProtection` dial —
// `off | observe | enforce`, default `off` — following the established dial
// plumbing (cfcWriteFloor / cfcPolicyEvaluation): RuntimeOptions → per-tx
// threading at edit() → CfcTxState, with the anti-downgrade pin (once
// `enforce`, weakening throws) and prepared-state invalidation on a real
// mode change after prepare.
describe("CFC label-metadata protection dial (inv-12 Stage 1)", () => {
  const makeRuntime = (mode?: CfcLabelMetadataProtectionMode) => {
    const storageManager = StorageManager.emulate({ as: signer });
    return new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      ...(mode !== undefined ? { cfcLabelMetadataProtection: mode } : {}),
    });
  };

  it("defaults to off and threads the option onto each transaction", () => {
    const offRuntime = makeRuntime();
    const offTx = offRuntime.edit();
    expect(offTx.getCfcState().labelMetadataProtectionMode).toBe("off");
    offTx.abort();

    const enforceRuntime = makeRuntime("enforce");
    const enforceTx = enforceRuntime.edit();
    expect(enforceTx.getCfcState().labelMetadataProtectionMode).toBe(
      "enforce",
    );
    enforceTx.abort();

    const observeRuntime = makeRuntime("observe");
    const observeTx = observeRuntime.edit();
    expect(observeTx.getCfcState().labelMetadataProtectionMode).toBe(
      "observe",
    );
    observeTx.abort();
  });

  it("pins enforce against downgrade (anti-downgrade, mirrors cfcWriteFloor)", () => {
    const runtime = makeRuntime("enforce");
    const tx = runtime.edit();
    expect(() => tx.setCfcLabelMetadataProtectionMode("observe")).toThrow(
      /cannot be weakened/,
    );
    expect(() => tx.setCfcLabelMetadataProtectionMode("off")).toThrow(
      /cannot be weakened/,
    );
    // Re-asserting enforce is always allowed.
    tx.setCfcLabelMetadataProtectionMode("enforce");
    expect(tx.getCfcState().labelMetadataProtectionMode).toBe("enforce");
    tx.abort();
  });

  it("allows raising below the pin and pins at the first enforce", () => {
    const runtime = makeRuntime();
    const tx = runtime.edit();
    // off → observe → off: no pin yet, juggling allowed.
    tx.setCfcLabelMetadataProtectionMode("observe");
    tx.setCfcLabelMetadataProtectionMode("off");
    tx.setCfcLabelMetadataProtectionMode("enforce");
    expect(() => tx.setCfcLabelMetadataProtectionMode("observe")).toThrow(
      /cannot be weakened/,
    );
    tx.abort();
  });

  it("delegates through TransactionWrapper to the wrapped transaction", () => {
    // The wrapper forwards every dial setter; the new one must reach the
    // wrapped tx (and its pin) identically.
    const runtime = makeRuntime();
    const tx = runtime.edit();
    const wrapper = new TransactionWrapper(tx);
    wrapper.setCfcLabelMetadataProtectionMode("enforce");
    expect(tx.getCfcState().labelMetadataProtectionMode).toBe("enforce");
    expect(() => wrapper.setCfcLabelMetadataProtectionMode("off")).toThrow(
      /cannot be weakened/,
    );
    tx.abort();
  });

  it("invalidates a prepared transaction on a real mode change", () => {
    const runtime = makeRuntime();
    const tx = runtime.edit();
    tx.markCfcRelevant("test");
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    // Idempotent re-set of the current mode does not invalidate.
    tx.setCfcLabelMetadataProtectionMode("off");
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    // A real change after prepare invalidates the prepared decision (the
    // mode is not part of PreparedDigestInput — same discipline as
    // cfcWriteFloor / cfcPolicyEvaluation).
    tx.setCfcLabelMetadataProtectionMode("enforce");
    expect(tx.getCfcState().prepare.status).toBe("invalidated");
    tx.abort();
  });
});
